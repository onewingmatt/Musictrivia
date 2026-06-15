const { execSync, spawn } = require('child_process');
const path = require('path');
const levenshtein = require('fast-levenshtein');
const { db } = require('../db/setup');

// ---------------------------------------------------------------------------
// Normalization & answer matching
// ---------------------------------------------------------------------------

const normalize = (s) =>
    s.trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');

const checkAnswer = (guessTitle, guessArtist, actualTitle, actualArtist, threshold = 0.25) => {
    const isTitleCorrect = guessTitle && actualTitle
        ? isCorrectGuess(guessTitle, actualTitle, threshold)
        : false;
    const isArtistCorrect = guessArtist && actualArtist
        ? isCorrectGuess(guessArtist, actualArtist, threshold)
        : false;

    let points = 0;
    if (isTitleCorrect) points += 1;
    if (isArtistCorrect) points += 1;

    return {
        is_title_correct: isTitleCorrect,
        is_artist_correct: isArtistCorrect,
        actual_title: actualTitle,
        actual_artist: actualArtist,
        points_awarded: points,
    };
};

function isCorrectGuess(guess, actual, threshold = 0.25) {
    if (!guess || !actual) return false;
    const g = normalize(guess);
    const a = normalize(actual);
    if (g === a) return true;

    // Levenshtein fuzzy match
    const distance = levenshtein.get(g, a);
    const maxLength = Math.max(g.length, a.length);
    if (distance / maxLength <= threshold) return true;

    // Substring match: shorter string covers >= 40% of longer
    const [shorter, longer] = g.length < a.length ? [g, a] : [a, g];
    if (shorter.length >= 4 && longer.includes(shorter)) {
        if (shorter.length / longer.length >= 0.4) return true;
    }

    // Split on separators (&, feat., and, /, x, ,) and check each part
    const parts = a.split(/\s*(?:&|feat\.?|featuring|and|\/|x|,)\s*/i);
    if (parts.length > 1) {
        for (const part of parts) {
            const p = part.trim();
            if (p.length < 3) continue;
            const d = levenshtein.get(g, p);
            if (d / Math.max(g.length, p.length) <= threshold) return true;
        }
        const primary = parts[0].trim();
        if (g === primary) return true;
        const dPrimary = levenshtein.get(g, primary);
        if (dPrimary / Math.max(g.length, primary.length) <= threshold) return true;
    }

    return false;
}

// ---------------------------------------------------------------------------
// YouTube ID resolution (async, non-blocking)
// ---------------------------------------------------------------------------

const youtubeCache = new Map();

const searchQueries = [
    (t, a) => `${t} ${a} official audio`,
    (t, a) => `${t} ${a} official`,
    (t, a) => `${t} ${a}`,
    (t, a) => `${t} ${a} vevo`,
];

function resolveYoutubeId(title, artist) {
    const key = `${title}|||${artist}`;
    if (youtubeCache.has(key)) return youtubeCache.get(key);

    const cookiePath = '/data/cookies.txt';
    const extraArgs = [
        '--js-runtime', 'node',
        '--remote-components', 'ejs:github',
    ];
    const cookieArg = require('fs').existsSync(cookiePath)
        ? ['--cookies', cookiePath]
        : [];

    for (const queryFn of searchQueries) {
        try {
            const result = execSync(
                `yt-dlp ${extraArgs.join(' ')} ${cookieArg.join(' ')} --flat-playlist --print id --match-filter 'duration<600' "ytsearch1:${queryFn(title, artist).replace(/"/g, '\\"')}"`,
                { timeout: 12000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
            ).trim();
            if (result && result.length === 11) {
                youtubeCache.set(key, result);
                // Persist to DB asynchronously (fire-and-forget)
                db.run(
                    "UPDATE songs SET youtube_id = ?, audio_url = ? WHERE title = ? AND artist = ?",
                    [result, result, title, artist],
                    (err) => { if (err) console.error('Failed to persist YouTube ID', err.message); }
                );
                return result;
            }
        } catch (e) {
            // try next query
        }
    }

    youtubeCache.set(key, null);
    return null;
}

function resolveYoutubeIdAsync(title, artist, cache) {
    return new Promise((resolve) => {
        // Use provided cache or fall back to global
        const store = cache || youtubeCache;
        const key = `${title}|||${artist}`;
        if (store.has(key)) return resolve(store.get(key));

        const cookiePath = '/data/cookies.txt';
        const extraArgs = [
            '--js-runtime', 'node',
            '--remote-components', 'ejs:github',
            '--flat-playlist', '--print', 'id',
            '--match-filter', 'duration<600',
        ];
        const cookieArg = require('fs').existsSync(cookiePath)
            ? ['--cookies', cookiePath]
            : [];

        const tryQuery = (idx) => {
            if (idx >= searchQueries.length) {
                store.set(key, null);
                return resolve(null);
            }
            const query = searchQueries[idx](title, artist);
            const child = spawn('yt-dlp', [
                ...extraArgs, ...cookieArg,
                `ytsearch1:${query}`,
            ], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 12000 });

            let output = '';
            child.stdout.on('data', (d) => { output += d.toString(); });
            child.on('error', () => tryQuery(idx + 1));
            child.on('close', (code) => {
                const id = output.trim();
                if (code === 0 && id.length === 11) {
                    store.set(key, id);
                    db.run(
                        "UPDATE songs SET youtube_id = ?, audio_url = ? WHERE title = ? AND artist = ?",
                        [id, id, title, artist],
                        (err) => { if (err) console.error('Failed to persist YouTube ID', err.message); }
                    );
                    resolve(id);
                } else {
                    tryQuery(idx + 1);
                }
            });
        };

        tryQuery(0);
    });
}

// ---------------------------------------------------------------------------
// Quiz generation
// ---------------------------------------------------------------------------

const dbAll = (q, p) => new Promise((res, rej) => db.all(q, p, (e, r) => e ? rej(e) : res(r)));
const dbGet = (q, p) => new Promise((res, rej) => db.get(q, p, (e, r) => e ? rej(e) : res(r)));

async function generateQuestions(settings) {
    const {
        genre_weights = {},
        decade_weights = {},
        source_weights = {},
        decades = [],
        limit = 10,
        skip_mastered = false,
        min_popularity = 0,
        max_popularity = 100,
        exclude_song_ids = [],
        userId = null,
    } = settings;

    const activeSources = Object.entries(source_weights)
        .filter(([, w]) => w > 0)
        .map(([s]) => s);

    const hasSongSourcesTable = await dbGet(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'song_sources' AND (SELECT COUNT(*) FROM song_sources) > 0",
        []
    );

    let query, params;
    if (activeSources.length > 0 && hasSongSourcesTable) {
        query = `SELECT DISTINCT s.* FROM songs s
                 INNER JOIN song_sources ss ON ss.song_id = s.id
                 WHERE s.popularity >= ? AND s.popularity <= ?
                 AND ss.source IN (${activeSources.map(() => '?').join(',')})`;
        params = [min_popularity, max_popularity, ...activeSources];
    } else {
        query = `SELECT * FROM songs s WHERE s.popularity >= ? AND s.popularity <= ?`;
        params = [min_popularity, max_popularity];
    }

    if (decades.length > 0) {
        query += ` AND s.decade IN (${decades.map(() => '?').join(',')})`;
        params.push(...decades);
    }

    const activeGenres = Object.entries(genre_weights)
        .filter(([, w]) => w > 0)
        .map(([g]) => g);

    if (activeGenres.length > 0) {
        query += ` AND s.genre IN (${activeGenres.map(() => '?').join(',')})`;
        params.push(...activeGenres);
    }

    if (skip_mastered && userId) {
        query += ` AND s.id NOT IN (
            SELECT song_id FROM user_answers
            WHERE user_id = ? AND is_title_correct = 1 AND is_artist_correct = 1
        )`;
        params.push(userId);
    }

    if (exclude_song_ids.length > 0) {
        query += ` AND s.id NOT IN (${exclude_song_ids.map(() => '?').join(',')})`;
        params.push(...exclude_song_ids);
    }

    const fetchLimit = Math.max(limit * 5, 50);
    query += ` ORDER BY RANDOM() LIMIT ?`;
    params.push(fetchLimit);

    const rows = await dbAll(query, params);
    if (rows.length === 0) return [];

    // Weighted sampling
    const hasGenreWeights = activeGenres.length > 0;
    const hasDecadeWeights = Object.values(decade_weights).some(w => w > 0);
    const hasSourceWeights = activeSources.length > 0;

    let selected;
    if (hasGenreWeights || hasDecadeWeights || hasSourceWeights) {
        let sourceMap = {};
        if (hasSourceWeights && rows.length > 0) {
            const songIds = rows.map(r => r.id);
            const srcRows = await dbAll(
                `SELECT song_id, source, source_popularity FROM song_sources WHERE song_id IN (${songIds.map(() => '?').join(',')})`,
                songIds
            );
            srcRows.forEach(r => {
                if (!sourceMap[r.song_id]) sourceMap[r.song_id] = [];
                sourceMap[r.song_id].push(r);
            });
        }

        const weighted = rows.map(r => {
            const gw = genre_weights[r.genre] || 1;
            const dw = decade_weights[r.decade] || 1;
            let sw = 1;
            if (hasSourceWeights) {
                const sources = sourceMap[r.id] || [];
                if (sources.length > 0) {
                    sw = Math.max(...sources.map(s => source_weights[s.source] || 0));
                    if (sw === 0) sw = 0.1;
                }
            }
            return { ...r, _weight: gw * dw * sw };
        });

        selected = [];
        const pool = [...weighted];
        for (let i = 0; i < Math.min(limit, pool.length); i++) {
            const totalWeight = pool.reduce((sum, item) => sum + item._weight, 0);
            let rand = Math.random() * totalWeight;
            let idx = 0;
            for (let j = 0; j < pool.length; j++) {
                rand -= pool[j]._weight;
                if (rand <= 0) { idx = j; break; }
            }
            selected.push(pool.splice(idx, 1)[0]);
        }
    } else {
        selected = rows.slice(0, Math.min(limit, rows.length));
    }

    // Return full song metadata (caller strips title/artist for client-facing responses)
    return selected.map(r => ({
        id: r.id,
        title: r.title,
        artist: r.artist,
        audio_url: r.youtube_id || (r.audio_url && r.audio_url.length === 11 ? r.audio_url : ''),
        genre: r.genre,
        decade: r.decade,
    }));
}

module.exports = {
    generateQuestions,
    checkAnswer,
    resolveYoutubeIdAsync,
    resolveYoutubeId,
    isCorrectGuess,
    normalize,
};
