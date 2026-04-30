const express = require('express');
const router = express.Router();
const { db } = require('../db/setup');
const authenticateToken = require('../middleware/auth');
const levenshtein = require('fast-levenshtein');
const { execSync } = require('child_process');

// Helper to determine if a guess is close enough
const isCorrectGuess = (guess, actual) => {
    if (!guess || !actual) return false;
    const g = guess.trim().toLowerCase();
    const a = actual.trim().toLowerCase();
    if (g === a) return true;

    const distance = levenshtein.get(g, a);
    const maxLength = Math.max(g.length, a.length);

    // Allow ~25% error rate (e.g. 1 typo in 5 chars, 2 in 10)
    return distance / maxLength <= 0.25;
};

// Lazy YouTube ID resolution
const youtubeCache = new Map();
function resolveYoutubeId(title, artist) {
    const key = `${title}|||${artist}`;
    if (youtubeCache.has(key)) return youtubeCache.get(key);

    try {
        const query = `${title} ${artist} official`;
        const result = execSync(
            `yt-dlp --flat-playlist --print id --match-filter 'duration<600' "ytsearch1:${query.replace(/"/g, '\\"')}"`,
            { timeout: 10000, encoding: 'utf8' }
        ).trim();
        if (result && result.length === 11) {
            youtubeCache.set(key, result);
            // Also update DB
            db.run("UPDATE songs SET youtube_id = ?, audio_url = ? WHERE title = ? AND artist = ?",
                [result, result, title, artist]);
            return result;
        }
    } catch (e) {
        // YouTube lookup failed, cache null to avoid retrying
        youtubeCache.set(key, null);
    }
    return null;
}

router.post('/generate', authenticateToken, (req, res) => {
    const {
        genre_weights = {},   // e.g. { "Pop": 3, "Rock": 2, "Country": 1 }
        decade_weights = {},  // e.g. { "1980": 3, "1990": 2 }
        decades = [],
        limit = 10,
        skip_mastered = false,
        min_popularity = 0,
        max_popularity = 100
    } = req.body;

    let query = `SELECT * FROM songs WHERE popularity >= ? AND popularity <= ?`;
    let params = [min_popularity, max_popularity];

    // Filter by decades if specified
    if (decades.length > 0) {
        const placeholders = decades.map(() => '?').join(',');
        query += ` AND decade IN (${placeholders})`;
        params.push(...decades);
    }

    // Filter by genres that have weight > 0 (if any weights specified)
    const activeGenres = Object.entries(genre_weights)
        .filter(([, w]) => w > 0)
        .map(([g]) => g);

    if (activeGenres.length > 0) {
        const placeholders = activeGenres.map(() => '?').join(',');
        query += ` AND genre IN (${placeholders})`;
        params.push(...activeGenres);
    }

    // Skip mastered logic
    if (skip_mastered && req.user) {
        query += ` AND id NOT IN (
            SELECT song_id FROM user_answers
            WHERE user_id = ? AND is_title_correct = 1 AND is_artist_correct = 1
        )`;
        params.push(req.user.userId);
    }

    // Fetch more than needed for weighted sampling
    const fetchLimit = Math.max(limit * 5, 50);
    query += ` ORDER BY RANDOM() LIMIT ?`;
    params.push(fetchLimit);

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error fetching songs' });

        if (rows.length === 0) {
            return res.json({ questions: [] });
        }

        // Combined weighted sampling using genre_weights + decade_weights
        const hasGenreWeights = activeGenres.length > 0;
        const hasDecadeWeights = Object.values(decade_weights).some(w => w > 0);

        let selected;
        if (hasGenreWeights || hasDecadeWeights) {
            const weighted = rows.map(r => {
                const gw = genre_weights[r.genre] || 1;
                const dw = decade_weights[r.decade] || 1;
                // Multiply genre and decade weights together
                return { ...r, _weight: gw * dw };
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
            // No weights, just take random sample
            selected = rows.slice(0, Math.min(limit, rows.length));
        }

        // Resolve YouTube IDs for selected songs (lazy, one at a time)
        const questions = [];
        for (const r of selected) {
            let ytId = r.youtube_id || (r.audio_url && r.audio_url.length === 11 ? r.audio_url : null);
            if (!ytId) {
                ytId = resolveYoutubeId(r.title, r.artist);
            }
            questions.push({
                id: r.id,
                audio_url: ytId || '',
                genre: r.genre,
                decade: r.decade
            });
        }

        res.json({ questions });
    });
});

router.post('/resolve-youtube', authenticateToken, (req, res) => {
    const { song_id } = req.body;
    if (!song_id) return res.status(400).json({ error: 'song_id required' });

    db.get("SELECT id, title, artist, youtube_id, audio_url FROM songs WHERE id = ?", [song_id], (err, song) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!song) return res.status(404).json({ error: 'Song not found' });

        // Already resolved
        if (song.youtube_id && song.youtube_id.length === 11) {
            return res.json({ youtube_id: song.youtube_id });
        }

        // Try to resolve
        const ytId = resolveYoutubeId(song.title, song.artist);
        if (ytId) {
            res.json({ youtube_id: ytId });
        } else {
            res.status(404).json({ error: 'Could not find YouTube video' });
        }
    });
});

router.post('/answer', authenticateToken, (req, res) => {
    const { song_id, guessed_title, guessed_artist } = req.body;

    if (!song_id) return res.status(400).json({ error: 'song_id is required' });

    db.get("SELECT title, artist FROM songs WHERE id = ?", [song_id], (err, song) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!song) return res.status(404).json({ error: 'Song not found' });

        const isTitleCorrect = isCorrectGuess(guessed_title, song.title);
        const isArtistCorrect = isCorrectGuess(guessed_artist, song.artist);

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

module.exports = router;
