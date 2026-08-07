const express = require('express');
const router = express.Router();
const { db } = require('../db/setup');
const authenticateToken = require('../middleware/auth');
const levenshtein = require('fast-levenshtein');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { execSync, execFile, spawn } = require('child_process');

const DEFAULT_SOURCES = [
    { source: 'billboard-us', label: 'Billboard Hot 100 (US)' },
    { source: 'billboard-canada', label: 'Canadian Hot 100' },
    { source: 'wikipedia-canada-number-ones', label: 'Canadian #1s (Pre-2007)' },
];

// Promisified db helpers
const dbAll = (query, params) => new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows));
});
const dbGet = (query, params) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => err ? reject(err) : resolve(row));
});

// Normalize a string for comparison: lowercase, strip punctuation, collapse whitespace
const normalize = (s) => s.trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');

// Helper to determine if a guess is close enough
const isCorrectGuess = (guess, actual, threshold = 0.25) => {
    if (!guess || !actual) return false;
    const g = normalize(guess);
    const a = normalize(actual);
    if (g === a) return true;

    // Levenshtein fuzzy match
    const distance = levenshtein.get(g, a);
    const maxLength = Math.max(g.length, a.length);
    if (distance / maxLength <= threshold) return true;

    // Substring match: if the shorter string is a substantial part of the longer one
    // e.g. "gloria estefan" should match "gloria estefan & miami sound machine"
    const [shorter, longer] = g.length < a.length ? [g, a] : [a, g];
    if (shorter.length >= 4 && longer.includes(shorter)) {
        // The guess must cover at least 40% of the actual answer
        if (shorter.length / longer.length >= 0.4) return true;
    }

    // Split on common separators (&, feat., and, x, /) and check if any part matches
    const parts = a.split(/\s*(?:&|feat\.?|featuring|and|\/|x|,)\s*/i);
    if (parts.length > 1) {
        for (const part of parts) {
            const p = part.trim();
            if (p.length < 3) continue;
            const d = levenshtein.get(g, p);
            const ml = Math.max(g.length, p.length);
            if (d / ml <= threshold) return true;
        }
        // Also check if guess matches the first (primary) part exactly or closely
        const primary = parts[0].trim();
        if (g === primary) return true;
        const dPrimary = levenshtein.get(g, primary);
        if (dPrimary / Math.max(g.length, primary.length) <= threshold) return true;
    }

    return false;
};

// Lazy YouTube ID resolution
const youtubeCache = new Map();
function resolveYoutubeId(title, artist) {
    const key = `${title}|||${artist}`;
    if (youtubeCache.has(key)) return youtubeCache.get(key);

    const queries = [
        `${title} ${artist} official audio`,
        `${title} ${artist} official`,
        `${title} ${artist}`,
        `${title} ${artist} vevo`,
    ];

    try {
        for (const query of queries) {
            try {
                const result = execSync(
                    `yt-dlp --flat-playlist --print id --match-filter 'duration<600' "ytsearch1:${query.replace(/\"/g, '\\\\\\\"')}"`,
                    { timeout: 12000, encoding: 'utf8' }
                ).trim();
                if (result && result.length === 11) {
                    youtubeCache.set(key, result);
                    db.run(
                        "UPDATE songs SET youtube_id = ?, audio_url = ? WHERE title = ? AND artist = ?",
                        [result, result, title, artist],
                        (err) => { if (err) console.error('Failed to persist resolved youtube id', err); }
                    );
                    return result;
                }
            } catch (inner) {
                // try next query
            }
        }
    } catch (e) {
        // fall through
    }

    youtubeCache.set(key, null);
    return null;
}

router.post('/generate', authenticateToken, async (req, res) => {
    try {
        const {
            genre_weights = {},
            decade_weights = {},
            source_weights = {},
            decades = [],
            limit = 10,
            skip_mastered = false,
            min_popularity = 0,
            max_popularity = 100,
            market = 'us'
        } = req.body;

        // Popularity market: 'us' (full US Hot 100 history) or 'ca' (Canadian charts)
        const popCol = market === 'ca' ? 'ca_popularity' : 'us_popularity';

        // If source weights specified, filter to songs that appear in active sources
        const activeSources = Object.entries(source_weights)
            .filter(([, w]) => w > 0)
            .map(([s]) => s);
        const hasSongSourcesTable = await dbGet(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'song_sources'",
            []
        );

        let query, params;
        if (activeSources.length > 0 && hasSongSourcesTable) {
            query = `SELECT DISTINCT s.* FROM songs s
                     INNER JOIN song_sources ss ON ss.song_id = s.id
                     WHERE s.${popCol} >= ? AND s.${popCol} <= ?
                     AND ss.source IN (${activeSources.map(() => '?').join(',')})`;
            params = [min_popularity, max_popularity, ...activeSources];
        } else {
            query = `SELECT * FROM songs s WHERE s.${popCol} >= ? AND s.${popCol} <= ?`;
            params = [min_popularity, max_popularity];
        }

        // Filter by decades if specified
        if (decades.length > 0) {
            const placeholders = decades.map(() => '?').join(',');
            query += ` AND s.decade IN (${placeholders})`;
            params.push(...decades);
        }

        // Filter by genres that have weight > 0
        const activeGenres = Object.entries(genre_weights)
            .filter(([, w]) => w > 0)
            .map(([g]) => g);

        if (activeGenres.length > 0) {
            const placeholders = activeGenres.map(() => '?').join(',');
            query += ` AND s.genre IN (${placeholders})`;
            params.push(...activeGenres);
        }

        // Skip mastered logic
        if (skip_mastered && req.user) {
            query += ` AND s.id NOT IN (
                SELECT song_id FROM user_answers
                WHERE user_id = ? AND is_title_correct = 1 AND is_artist_correct = 1
            )`;
            params.push(req.user.userId);
        }

        // Fetch more than needed for weighted sampling
        const fetchLimit = Math.max(limit * 5, 50);
        query += ` ORDER BY RANDOM() LIMIT ?`;
        params.push(fetchLimit);

        const rows = await dbAll(query, params);

        if (rows.length === 0) {
            return res.json({ questions: [] });
        }

        // Combined weighted sampling using genre_weights + decade_weights + source_weights
        const hasGenreWeights = activeGenres.length > 0;
        const hasDecadeWeights = Object.values(decade_weights).some(w => w > 0);
        const hasSourceWeights = activeSources.length > 0;

        let selected;
        if (hasGenreWeights || hasDecadeWeights || hasSourceWeights) {
            // Fetch source data for the selected songs if source weights are active
            let sourceMap = {};
            if (hasSourceWeights && rows.length > 0) {
                const songIds = rows.map(r => r.id);
                const idPlaceholders = songIds.map(() => '?').join(',');
                const srcRows = await dbAll(
                    `SELECT song_id, source, source_popularity FROM song_sources WHERE song_id IN (${idPlaceholders})`,
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

                // Source weight: max weight across all sources this song appears in
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

            // Weighted random selection without replacement
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

        // Resolve YouTube IDs for selected songs (lazy, one at a time)
        const questions = [];
        for (const r of selected) {
            let ytId = r.youtube_id || (r.audio_url && r.audio_url.length === 11 ? r.audio_url : null);
            // Don't block on YouTube resolution — if not cached, send empty and resolve lazily
            questions.push({
                id: r.id,
                audio_url: ytId || '',
                genre: r.genre,
                decade: r.decade
            });
        }

        res.json({ questions });
    } catch (err) {
        console.error('Quiz generate error:', err);
        res.status(500).json({ error: 'Database error fetching songs' });
    }
});

router.post('/resolve-youtube', authenticateToken, (req, res) => {
    const { song_id } = req.body;
    if (!song_id) return res.status(400).json({ error: 'song_id required' });

    db.get("SELECT id, title, artist, youtube_id, audio_url FROM songs WHERE id = ?", [song_id], (err, song) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!song) return res.status(404).json({ error: 'Song not found' });

        if (song.youtube_id && song.youtube_id.length === 11) {
            return res.json({ youtube_id: song.youtube_id });
        }

        const ytId = resolveYoutubeId(song.title, song.artist);
        if (ytId) {
            res.json({ youtube_id: ytId });
        } else {
            res.status(404).json({ error: 'Could not find YouTube video' });
        }
    });
});

router.post('/answer', authenticateToken, (req, res) => {
    const { song_id, guessed_title, guessed_artist, fuzzy_threshold = 0.25 } = req.body;

    if (!song_id) return res.status(400).json({ error: 'song_id is required' });

    db.get("SELECT title, artist FROM songs WHERE id = ?", [song_id], (err, song) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!song) return res.status(404).json({ error: 'Song not found' });

        const isTitleCorrect = isCorrectGuess(guessed_title, song.title, fuzzy_threshold);
        const isArtistCorrect = isCorrectGuess(guessed_artist, song.artist, fuzzy_threshold);

        let points = 0;
        if (isTitleCorrect) points += 1;
        if (isArtistCorrect) points += 1;

        if (req.user) {
            db.run(
                `INSERT INTO user_answers (user_id, song_id, guessed_title, guessed_artist, is_title_correct, is_artist_correct, points_awarded)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [req.user.userId, song_id, guessed_title, guessed_artist, isTitleCorrect, isArtistCorrect, points],
                (insertErr) => {
                    if (insertErr) console.error("Failed to save answer history", insertErr);
                }
            );
        }

        res.json({
            is_title_correct: isTitleCorrect,
            is_artist_correct: isArtistCorrect,
            actual_title: song.title,
            actual_artist: song.artist,
            points_awarded: points
        });
    });
});

// Return available genres with counts
router.get('/genres', (req, res) => {
    db.all("SELECT genre, COUNT(*) as count FROM songs GROUP BY genre ORDER BY count DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ genres: rows });
    });
});

// Return available decades with counts
router.get('/decades', (req, res) => {
    db.all("SELECT decade, COUNT(*) as count FROM songs GROUP BY decade ORDER BY decade", [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ decades: rows });
    });
});

// Return available sources with counts
router.get('/sources', (req, res) => {
    db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'song_sources'", [], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!row) {
            return res.json({
                sources: DEFAULT_SOURCES.map(s => ({ source: s.source, song_count: 0, total_entries: 0 }))
            });
        }

        db.all(
            `SELECT source, COUNT(DISTINCT song_id) as song_count, SUM(chart_entries) as total_entries
             FROM song_sources GROUP BY source ORDER BY song_count DESC`,
            [],
            (err2, rows) => {
                if (err2) return res.status(500).json({ error: 'Database error' });
                res.json({ sources: rows });
            }
        );
    });
});

// Config management
router.get('/configs', authenticateToken, (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Login required to manage presets' });
    db.all("SELECT * FROM quiz_configs WHERE user_id = ? ORDER BY created_at DESC", [req.user.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ configs: rows.map(r => ({ ...r, config: JSON.parse(r.config_json) })) });
    });
});

router.post('/configs', authenticateToken, (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Login required to save presets' });
    const { name, config } = req.body;
    if (!name || !config) return res.status(400).json({ error: 'name and config are required' });

    db.run(
        "INSERT INTO quiz_configs (user_id, name, config_json) VALUES (?, ?, ?)",
        [req.user.userId, name, JSON.stringify(config)],
        function(err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ id: this.lastID, name, config });
        }
    );
});

router.delete('/configs/:id', authenticateToken, (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Login required' });
    db.run("DELETE FROM quiz_configs WHERE id = ? AND user_id = ?", [req.params.id, req.user.userId], function(err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (this.changes === 0) return res.status(404).json({ error: 'Config not found' });
        res.json({ success: true });
    });
});

// Report a broken/incorrect song (creates a song_reports row for the admin panel)
router.post('/report', authenticateToken, (req, res) => {
    const { song_id, reason = 'audio_failed', note = '' } = req.body;

    if (!song_id) return res.status(400).json({ error: 'song_id is required' });

    db.get("SELECT id, title, artist FROM songs WHERE id = ?", [song_id], (err, song) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!song) return res.status(404).json({ error: 'Song not found' });

        db.run(
            `INSERT INTO song_reports (song_id, user_id, reason, note)
             VALUES (?, ?, ?, ?)`,
            [song_id, req.user?.userId || null, reason, note],
            function(insertErr) {
                if (insertErr) return res.status(500).json({ error: 'Failed to save report' });
                res.json({
                    success: true,
                    report_id: this.lastID,
                    song_id: song.id,
                    title: song.title,
                    artist: song.artist
                });
            }
        );
    });
});

// Audio stream proxy — resolves a direct YouTube audio URL via yt-dlp and pipes it through
// the backend so the browser never touches the YouTube iframe (fixes hidden-iframe stutter
// and the media-session metadata leak).
const audioStreamCache = new Map(); // youtubeId -> { url, expires }
const AUDIO_STREAM_TTL = 60 * 60 * 1000; // 1 hour

function resolveAudioStreamUrl(youtubeId) {
    const cached = audioStreamCache.get(youtubeId);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.url);

    return new Promise((resolve, reject) => {
        const YT_PROXY = process.env.YT_PROXY || '';
        const proxyArg = YT_PROXY ? ['--proxy', YT_PROXY] : [];
        const cookiePath = process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), 'cookies.txt') : '';
        const cookieArg = cookiePath && fs.existsSync(cookiePath) ? ['--cookies', cookiePath] : [];
        const args = [
            '--js-runtime', 'node',
            '--remote-components', 'ejs:github',
            ...proxyArg,
            ...cookieArg,
            '-f', 'bestaudio[ext=m4a]/bestaudio/best',
            '--get-url',
            `https://www.youtube.com/watch?v=${youtubeId}`,
        ];

        execFile('yt-dlp', args, { timeout: 20000 }, (err, stdout) => {
            if (err) return reject(err);
            const url = stdout.trim();
            if (!url) return reject(new Error('Empty stream URL'));
            audioStreamCache.set(youtubeId, { url, expires: Date.now() + AUDIO_STREAM_TTL });
            resolve(url);
        });
    });
}

// Fallback streaming path: pipe yt-dlp stdout straight to the client (same pipeline the
// Discord bot uses). Handles videos whose direct googlevideo URL is IP-locked to the
// residential proxy and 403s on a plain fetch. With ?start=N, runs through ffmpeg so
// random-start offsets are applied server-side.
function streamViaYtDlp(youtubeId, startSec, res) {
    const YT_PROXY = process.env.YT_PROXY || '';
    const proxyArg = YT_PROXY ? ['--proxy', YT_PROXY] : [];
    const cookiePath = process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), 'cookies.txt') : '';
    const cookieArg = cookiePath && fs.existsSync(cookiePath) ? ['--cookies', cookiePath] : [];
    const baseArgs = ['--js-runtime', 'node', '--remote-components', 'ejs:github', ...proxyArg, ...cookieArg];

    const ytdlp = spawn('yt-dlp', [...baseArgs, '-f', '140', '-o', '-', `https://www.youtube.com/watch?v=${youtubeId}`]);
    let source = ytdlp.stdout;
    let contentType = 'audio/mp4';
    let ffmpeg = null;

    if (startSec > 0) {
        ffmpeg = spawn('ffmpeg', ['-i', 'pipe:0', '-ss', String(startSec), '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1']);
        ytdlp.stdout.pipe(ffmpeg.stdin);
        source = ffmpeg.stdout;
        contentType = 'audio/mpeg';
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');

    let gotData = false;
    source.on('data', () => { gotData = true; });
    source.pipe(res);

    const noDataTimer = setTimeout(() => {
        if (!gotData && !res.headersSent) {
            res.status(502).json({ error: 'No audio data' });
            ytdlp.kill();
            if (ffmpeg) ffmpeg.kill();
        }
    }, 15000);
    source.on('end', () => clearTimeout(noDataTimer));
    res.on('close', () => {
        clearTimeout(noDataTimer);
        ytdlp.kill();
        if (ffmpeg) ffmpeg.kill();
    });
}

router.get('/audio-stream/:youtubeId', async (req, res) => {
    const { youtubeId } = req.params;
    if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) return res.status(400).json({ error: 'Invalid video id' });
    const startSec = Math.max(0, parseFloat(req.query.start) || 0);

    // Random start: apply the offset server-side via ffmpeg (always works)
    if (startSec > 0) {
        return streamViaYtDlp(youtubeId, startSec, res);
    }

    // Fast path: cached direct URL piped through (seekable, cached 1h).
    try {
        const url = await resolveAudioStreamUrl(youtubeId);
        const upstream = await fetch(url, {
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
        });
        if (upstream.ok && upstream.body) {
            res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
            res.setHeader('Cache-Control', 'no-store');
            const contentLength = upstream.headers.get('content-length');
            if (contentLength) res.setHeader('Content-Length', contentLength);
            Readable.fromWeb(upstream.body).pipe(res);
            return;
        }
        console.error('Audio stream upstream rejected:', youtubeId, upstream.status);
    } catch (err) {
        console.error('Audio stream resolve failed:', youtubeId, err.message);
    }

    // Fallback: stream via the yt-dlp pipe (handles IP-locked / 403 URLs)
    streamViaYtDlp(youtubeId, 0, res);
});

module.exports = router;
