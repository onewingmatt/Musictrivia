const express = require('express');
const router = express.Router();
const { db } = require('../db/setup');
const authenticateToken = require('../middleware/auth');

router.get('/stats', authenticateToken, (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const userId = req.user.userId;

    db.all(`SELECT * FROM user_answers WHERE user_id = ?`, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });

        const totalAnswers = rows.length;
        if (totalAnswers === 0) {
            return res.json({
                total_questions: 0,
                total_points: 0,
                accuracy_percentage: 0,
                mastered_songs_count: 0
            });
        }

        let totalPoints = 0;
        let masteredCount = 0;

        rows.forEach(r => {
            totalPoints += r.points_awarded;
            if (r.is_title_correct && r.is_artist_correct) {
                masteredCount += 1;
            }
        });

        const maxPossiblePoints = totalAnswers * 2;
        const accuracy = (totalPoints / maxPossiblePoints) * 100;

        res.json({
            total_questions: totalAnswers,
            total_points: totalPoints,
            accuracy_percentage: accuracy.toFixed(1),
            mastered_songs_count: masteredCount
        });
    });
});

module.exports = router;