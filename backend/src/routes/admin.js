const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { db } = require('../db/setup');
const { resolveYoutubeIdAsync } = require('../services/quizService');

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'musictrivia-admin-2026';

function requireAdmin(req, res, next) {
    const secret = req.query.secret || req.headers['x-admin-secret'];
    if (secret !== ADMIN_SECRET) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

const dbAll = (q, p) => new Promise((res, rej) => db.all(q, p, (e, r) => e ? rej(e) : res(r)));
const dbGet = (q, p) => new Promise((res, rej) => db.get(q, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (q, p) => new Promise((res, rej) => db.run(q, p, function(e) { if (e) rej(e); else res(this); }));

// Serve admin HTML page
router.get('/', requireAdmin, (req, res) => {
    const accept = req.headers.accept || '';
    if (!accept.includes('text/html')) {
        return res.json({ admin: true, secret: ADMIN_SECRET });
    }
    const htmlPath = path.resolve(__dirname, '../admin.html');
    if (fs.existsSync(htmlPath)) {
        res.type('html').send(fs.readFileSync(htmlPath, 'utf-8'));
    } else {
        res.status(500).send('admin.html not found');
    }
});

// List reports
router.get('/reports', requireAdmin, (req, res) => {
    db.all(`
        SELECT sr.id, sr.song_id, s.title, s.artist, s.youtube_id, s.audio_url,
               sr.reason, sr.note, sr.created_at, sr.user_id
        FROM song_reports sr
        JOIN songs s ON sr.song_id = s.id
        ORDER BY sr.created_at DESC
        LIMIT 200
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ reports: rows });
    });
});

// Dismiss a report
router.post('/reports/:id/dismiss', requireAdmin, (req, res) => {
    db.run("DELETE FROM song_reports WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ dismissed: true, id: parseInt(req.params.id) });
    });
});

// Re-resolve YouTube ID
router.post('/songs/:id/resolve', requireAdmin, async (req, res) => {
    try {
        const song = await dbGet("SELECT id, title, artist FROM songs WHERE id = ?", [req.params.id]);
        if (!song) return res.status(404).json({ error: 'Song not found' });

        const ytId = await resolveYoutubeIdAsync(song.title, song.artist, new Map());

        if (ytId) {
            await dbRun("UPDATE songs SET youtube_id = ?, audio_url = ? WHERE id = ?", [ytId, ytId, song.id]);
            res.json({ youtube_id: ytId, song_id: song.id });
        } else {
            res.json({ youtube_id: null, song_id: song.id });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manually set YouTube ID
router.put('/songs/:id/youtube', requireAdmin, (req, res) => {
    const { youtube_id } = req.body;
    if (!youtube_id) return res.status(400).json({ error: 'youtube_id required' });

    db.run("UPDATE songs SET youtube_id = ?, audio_url = ? WHERE id = ?",
        [youtube_id, youtube_id, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            if (this.changes === 0) return res.status(404).json({ error: 'Song not found' });
            res.json({ updated: true, song_id: parseInt(req.params.id), youtube_id });
        }
    );
});

// Hide song (soft-delete)
router.post('/songs/:id/hide', requireAdmin, (req, res) => {
    db.run("UPDATE songs SET hidden = 1 WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (this.changes === 0) return res.status(404).json({ error: 'Song not found' });
        res.json({ hidden: true, song_id: parseInt(req.params.id) });
    });
});

// Unhide song
router.post('/songs/:id/unhide', requireAdmin, (req, res) => {
    db.run("UPDATE songs SET hidden = 0 WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (this.changes === 0) return res.status(404).json({ error: 'Song not found' });
        res.json({ hidden: false, song_id: parseInt(req.params.id) });
    });
});

// Unflag a song auto-marked as broken audio (clears the flag + stall history)
router.post('/songs/:id/unflag', requireAdmin, (req, res) => {
    db.run(
        "UPDATE songs SET broken_audio = 0, broken_audio_reason = NULL, broken_audio_at = NULL, stall_count = 0 WHERE id = ?",
        [req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            if (this.changes === 0) return res.status(404).json({ error: 'Song not found' });
            res.json({ unflagged: true, song_id: parseInt(req.params.id) });
        }
    );
});

// Delete song permanently
router.delete('/songs/:id', requireAdmin, async (req, res) => {
    const songId = parseInt(req.params.id);
    try {
        await dbRun("DELETE FROM song_reports WHERE song_id = ?", [songId]);
        await dbRun("DELETE FROM song_sources WHERE song_id = ?", [songId]);
        await dbRun("DELETE FROM user_answers WHERE song_id = ?", [songId]);
        const result = await dbRun("DELETE FROM songs WHERE id = ?", [songId]);
        if (result.changes === 0) return res.status(404).json({ error: 'Song not found' });
        res.json({ deleted: true, song_id: songId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Song lookup
router.get('/songs/:id', requireAdmin, (req, res) => {
    db.get("SELECT id, title, artist, genre, decade, youtube_id, audio_url, popularity, hidden, broken_audio, broken_audio_reason, broken_audio_at, stall_count FROM songs WHERE id = ?",
        [req.params.id],
        (err, song) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            if (!song) return res.status(404).json({ error: 'Song not found' });
            res.json(song);
        }
    );
});

// Search songs
router.get('/search', requireAdmin, (req, res) => {
    const q = req.query.q || '';
    if (q.length < 2) return res.json({ songs: [] });
    db.all(
        "SELECT id, title, artist, hidden FROM songs WHERE title LIKE ? OR artist LIKE ? LIMIT 20",
        ['%' + q + '%', '%' + q + '%'],
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ songs: rows });
        }
    );
});

// Stats
router.get('/stats', requireAdmin, (req, res) => {
    db.get("SELECT (SELECT COUNT(*) FROM song_reports) as total, (SELECT COUNT(DISTINCT song_id) FROM song_reports) as unique_songs, (SELECT COUNT(*) FROM songs WHERE hidden = 1) as hidden_songs, (SELECT COUNT(*) FROM songs WHERE broken_audio = 1) as broken_songs", [], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(row);
    });
});

module.exports = router;
