const levenshtein = require('fast-levenshtein');
const play = require('play-dl');
const { db } = require('../db/setup');

const normalize = (s) => s.trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');

const isCorrectGuess = (guess, actual, threshold = 0.25) => {
    if (!guess || !actual) return false;
    const g = normalize(guess);
    const a = normalize(actual);
    if (g === a) return true;

    const distance = levenshtein.get(g, a);
    const maxLength = Math.max(g.length, a.length);
    if (distance / maxLength <= threshold) return true;

    const [shorter, longer] = g.length < a.length ? [g, a] : [a, g];
    if (shorter.length >= 4 && longer.includes(shorter)) {
        if (shorter.length / longer.length >= 0.4) return true;
    }

    const parts = a.split(/\s*(?:&|feat\.?|featuring|and|\/|x|,)\s*/i);
    if (parts.length > 1) {
        for (const part of parts) {
            const p = part.trim();
            if (p.length < 3) continue;
            const d = levenshtein.get(g, p);
            if (d / Math.max(g.length, p.length) <= threshold) return true;
        }
    }

    return false;
};

const resolveYoutubeIdAsync = async (title, artist, songId) => {
    const queries = [
        `${title} ${artist} official audio`,
        `${title} ${artist} official`,
        `${title} ${artist}`,
        `${title} ${artist} vevo`,
    ];

    for (const query of queries) {
        try {
            const result = await play.search(query, { limit: 1 });
            if (result && result.length > 0 && result[0].id) {
                // play-dl search usually returns objects with an `id`
                const ytId = result[0].id;
                // Double check it's 11 chars
                if (ytId.length === 11) {
                    return new Promise((resolve) => {
                        db.run(`UPDATE songs SET youtube_id = ? WHERE id = ?`, [ytId, songId], () => {
                            resolve(ytId);
                        });
                    });
                }
            }
        } catch (e) {
            continue;
        }
    }
    return null;
};

module.exports = {
    isCorrectGuess,
    resolveYoutubeIdAsync
};
