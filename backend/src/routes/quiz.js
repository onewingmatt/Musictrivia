const express = require('express');
const router = express.Router();
const { db } = require('../db/setup');
const authenticateToken = require('../middleware/auth');
const levenshtein = require('fast-levenshtein');

// Helper to determine if a guess is close enough
const isCorrectGuess = (guess, actual) => {
    if (!guess || !actual) return false;
    const g = guess.trim().toLowerCase();
    const a = actual.trim().toLowerCase();
    if (g === a) return true;

    const distance = levenshtein.get(g, a);
    const maxLength = Math.max(g.length, a.length);

    // Allow ~20% error rate (e.g. 1 typo in 5 chars, 2 in 10)
    return distance / maxLength <= 0.25;
};

router.post('/generate', authenticateToken, (req, res) => {
    const {
        genres = [],
        decades = [],
        limit = 10,
        skip_mastered = false,
        min_popularity = 0,
        max_popularity = 100
    } = req.body;

    let query = `SELECT * FROM songs WHERE popularity >= ? AND popularity <= ?`;
    let params = [min_popularity, max_popularity];

    if (genres.length > 0) {
        const placeholders = genres.map(() => '?').join(',');
        query += ` AND genre IN (${placeholders})`;
        params.push(...genres);
    }

    if (decades.length > 0) {
        const placeholders = decades.map(() => '?').join(',');
        query += ` AND decade IN (${placeholders})`;
        params.push(...decades);
    }

    // Skip mastered logic
    if (skip_mastered && req.user) {
        query += ` AND id NOT IN (
            SELECT song_id FROM user_answers
            WHERE user_id = ? AND is_title_correct = 1 AND is_artist_correct = 1
        )`;
        params.push(req.user.userId);
    }

    query += ` ORDER BY RANDOM() LIMIT ?`;
    params.push(limit);

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error fetching songs' });

        // Don't send exact title/artist down to client so they can't cheat via devtools
        const questions = rows.map(r => ({
            id: r.id,
            audio_url: r.audio_url,
            genre: r.genre,
            decade: r.decade
        }));

        res.json({ questions });
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
            // Save to history
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

module.exports = router;