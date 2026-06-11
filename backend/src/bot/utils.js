const levenshtein = require('fast-levenshtein');
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

const resolveYoutubeIdAsync = async () => null;

module.exports = {
    isCorrectGuess,
    resolveYoutubeIdAsync
};
