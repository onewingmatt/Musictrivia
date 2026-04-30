import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';

const ALL_GENRES = [
    "Pop", "Rock", "Hip Hop", "R&B", "Country", "Electronic",
    "Indie", "Alternative", "Jazz", "Blues", "Folk", "Metal",
    "Punk", "Funk", "Disco", "Latin", "K-Pop", "Singer-Songwriter",
    "Reggae", "Gospel", "Classical"
];
const ALL_DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];

const QuizSetupScreen = () => {
    const navigate = useNavigate();
    const [genreWeights, setGenreWeights] = useState(() => {
        const initial = {};
        ALL_GENRES.forEach(g => initial[g] = 0);
        return initial;
    });
    const [decadeWeights, setDecadeWeights] = useState(() => {
        const initial = {};
        ALL_DECADES.forEach(d => initial[d] = 0);
        return initial;
    });
    const [popularityRange, setPopularityRange] = useState([50, 100]);
    const [skipMastered, setSkipMastered] = useState(false);
    const [randomStart, setRandomStart] = useState(false);
    const [questionCount, setQuestionCount] = useState(5);
    const [loading, setLoading] = useState(false);
    const [genreCounts, setGenreCounts] = useState({});
    const [volume, setVolume] = useState(() => parseInt(localStorage.getItem('quizVolume') || '70'));
    const [clipDuration, setClipDuration] = useState(() => parseInt(localStorage.getItem('quizClipDuration') || '15'));
    const [loopClip, setLoopClip] = useState(() => localStorage.getItem('quizLoopClip') === 'true');

    useEffect(() => {
        api.get('/quiz/genres').then(res => {
            const counts = {};
            res.data.genres.forEach(g => counts[g.genre] = g.count);
            setGenreCounts(counts);
        }).catch(() => {});
    }, []);

    const setAllGenres = (value) => {
        setGenreWeights(prev => {
            const next = {};
            ALL_GENRES.forEach(g => next[g] = value);
            return next;
        });
    };

    const setAllDecades = (value) => {
        setDecadeWeights(prev => {
            const next = {};
            ALL_DECADES.forEach(d => next[d] = value);
            return next;
        });
    };

    const activeGenreCount = Object.values(genreWeights).filter(w => w > 0).length;
    const activeDecadeCount = Object.values(decadeWeights).filter(w => w > 0).length;

    const handleStart = async () => {
        setLoading(true);
        try {
            // Build decades array from weights (only include decades with weight > 0)
            const activeDecades = Object.entries(decadeWeights)
                .filter(([, w]) => w > 0)
                .map(([d]) => parseInt(d));

            const res = await api.post('/quiz/generate', {
                genre_weights: genreWeights,
                decade_weights: decadeWeights,
                decades: activeDecades,
                skip_mastered: skipMastered,
                min_popularity: popularityRange[0],
                max_popularity: popularityRange[1],
                limit: questionCount
            });

            if (res.data.questions.length === 0) {
                alert("No songs matched your filters. Try adjusting genres or popularity.");
                setLoading(false);
                return;
            }

            sessionStorage.setItem('currentQuiz', JSON.stringify(res.data.questions));
            sessionStorage.setItem('quizSettings', JSON.stringify({ randomStart, clipDuration, loopClip }));
            navigate('/play');
        } catch (err) {
            console.error("Error generating quiz", err);
            alert("Failed to generate quiz. Do you have enough matching songs?");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="max-w-3xl mx-auto mt-10 p-8 bg-white rounded-xl shadow-md">
            <h1 className="text-3xl font-bold mb-6 border-b pb-4">Configure Your Quiz</h1>

            {/* Genre Weight Sliders */}
            <details className="mb-6 group" open={activeGenreCount > 0}>
                <summary className="flex items-center justify-between cursor-pointer select-none list-none">
                    <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
                        <h3 className="text-lg font-semibold">Genre Mix</h3>
                        {activeGenreCount > 0 && (
                            <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">{activeGenreCount} active</span>
                        )}
                    </div>
                    <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                        <button
                            onClick={() => setAllGenres(0)}
                            className="text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200"
                        >
                            Clear All
                        </button>
                        <button
                            onClick={() => setAllGenres(3)}
                            className="text-xs px-3 py-1 rounded-full bg-indigo-100 text-indigo-700 hover:bg-indigo-200"
                        >
                            Equal Mix
                        </button>
                    </div>
                </summary>
                <div className="mt-3">
                    <p className="text-sm text-gray-500 mb-4">
                        Set how much of each genre you want. Higher = more likely to appear. Leave at 0 to exclude.
                    </p>
                    <div className="space-y-3">
                        {ALL_GENRES.map(genre => {
                            const count = genreCounts[genre] || 0;
                            if (count === 0 && genreWeights[genre] === 0) return null;
                            return (
                                <div key={genre} className="flex items-center gap-3">
                                    <span className="w-36 text-sm font-medium text-gray-700 flex justify-between">
                                        <span>{genre}</span>
                                        <span className="text-gray-400 text-xs">({count})</span>
                                    </span>
                                    <input
                                        type="range"
                                        min="0" max="5" step="1"
                                        value={genreWeights[genre]}
                                        onChange={(e) => setGenreWeights(prev => ({...prev, [genre]: parseInt(e.target.value)}))}
                                        className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                                    />
                                    <span className="w-6 text-center text-sm font-mono text-gray-500">
                                        {genreWeights[genre] > 0 ? genreWeights[genre] : '-'}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                    {activeGenreCount === 0 && (
                        <p className="mt-2 text-amber-600 text-sm">No genres selected — all genres will be included equally.</p>
                    )}
                </div>
            </details>

            {/* Decade Weight Sliders */}
            <details className="mb-6 group" open={activeDecadeCount > 0}>
                <summary className="flex items-center justify-between cursor-pointer select-none list-none">
                    <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
                        <h3 className="text-lg font-semibold">Decade Mix</h3>
                        {activeDecadeCount > 0 && (
                            <span className="text-xs bg-pink-100 text-pink-700 px-2 py-0.5 rounded-full">{activeDecadeCount} active</span>
                        )}
                    </div>
                    <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                        <button
                            onClick={() => setAllDecades(0)}
                            className="text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200"
                        >
                            Clear All
                        </button>
                        <button
                            onClick={() => setAllDecades(3)}
                            className="text-xs px-3 py-1 rounded-full bg-pink-100 text-pink-700 hover:bg-pink-200"
                        >
                            Equal Mix
                        </button>
                    </div>
                </summary>
                <div className="mt-3">
                    <p className="text-sm text-gray-500 mb-4">
                        Set how much of each decade you want. Higher = more likely to appear. Leave at 0 to exclude.
                    </p>
                    <div className="space-y-3">
                        {ALL_DECADES.map(decade => (
                            <div key={decade} className="flex items-center gap-3">
                                <span className="w-36 text-sm font-medium text-gray-700">{decade}s</span>
                                <input
                                    type="range"
                                    min="0" max="5" step="1"
                                    value={decadeWeights[decade]}
                                    onChange={(e) => setDecadeWeights(prev => ({...prev, [decade]: parseInt(e.target.value)}))}
                                    className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-pink-600"
                                />
                                <span className="w-6 text-center text-sm font-mono text-gray-500">
                                    {decadeWeights[decade] > 0 ? decadeWeights[decade] : '-'}
                                </span>
                            </div>
                        ))}
                    </div>
                    {activeDecadeCount === 0 && (
                        <p className="mt-2 text-amber-600 text-sm">No decades selected — all decades will be included equally.</p>
                    )}
                </div>
            </details>

            {/* Popularity Range */}
            <div className="mb-6">
                <h3 className="text-lg font-semibold mb-1">Popularity ({popularityRange[0]} – {popularityRange[1]})</h3>
                <p className="text-sm text-gray-500 mb-3">
                    Based on Billboard chart performance: peak position + weeks on chart. #1 hits with long runs score highest.
                </p>
                <div className="flex gap-4 items-center">
                    <div className="flex-1">
                        <label className="text-xs text-gray-500">Min</label>
                        <input
                            type="range"
                            min="0" max="100"
                            value={popularityRange[0]}
                            onChange={(e) => setPopularityRange(prev => [Math.min(parseInt(e.target.value), prev[1]), prev[1]])}
                            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                        />
                    </div>
                    <div className="flex-1">
                        <label className="text-xs text-gray-500">Max</label>
                        <input
                            type="range"
                            min="0" max="100"
                            value={popularityRange[1]}
                            onChange={(e) => setPopularityRange(prev => [prev[0], Math.max(parseInt(e.target.value), prev[0])])}
                            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                        />
                    </div>
                </div>
                <div className="flex justify-between text-sm text-gray-500 mt-1">
                    <span>Obscure (0)</span>
                    <span>Hits Only (100)</span>
                </div>
            </div>

            {/* Question Count */}
            <div className="mb-6">
                <h3 className="text-lg font-semibold mb-3">Questions ({questionCount})</h3>
                <input
                    type="range"
                    min="3" max="20" step="1"
                    value={questionCount}
                    onChange={(e) => setQuestionCount(parseInt(e.target.value))}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                />
                <div className="flex justify-between text-sm text-gray-500 mt-1">
                    <span>Quick (3)</span>
                    <span>Marathon (20)</span>
                </div>
            </div>

            {/* Checkboxes */}
            <div className="mb-8 space-y-4">
                <label className="flex items-center space-x-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={skipMastered}
                        onChange={(e) => setSkipMastered(e.target.checked)}
                        className="w-5 h-5 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500"
                    />
                    <span className="text-lg font-medium text-gray-700">Skip songs I've already mastered</span>
                </label>
                <label className="flex items-center space-x-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={randomStart}
                        onChange={(e) => setRandomStart(e.target.checked)}
                        className="w-5 h-5 text-purple-600 rounded border-gray-300 focus:ring-purple-500"
                    />
                    <span className="text-lg font-medium text-gray-700">Random start point</span>
                    <span className="text-sm text-gray-500">(song plays from a random point)</span>
                </label>
            </div>

            {/* Volume */}
            <div className="mb-6">
                <h3 className="text-lg font-semibold mb-3">Volume ({volume}%)</h3>
                <input
                    type="range"
                    min="0" max="100" step="5"
                    value={volume}
                    onChange={(e) => {
                        const v = parseInt(e.target.value);
                        setVolume(v);
                        localStorage.setItem('quizVolume', v);
                    }}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                />
                <div className="flex justify-between text-sm text-gray-500 mt-1">
                    <span>Mute</span>
                    <span>Full</span>
                </div>
            </div>

            {/* Clip Duration */}
            <div className="mb-6">
                <h3 className="text-lg font-semibold mb-3">Clip Length ({clipDuration}s)</h3>
                <input
                    type="range"
                    min="5" max="60" step="5"
                    value={clipDuration}
                    onChange={(e) => {
                        const v = parseInt(e.target.value);
                        setClipDuration(v);
                        localStorage.setItem('quizClipDuration', v);
                    }}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                />
                <div className="flex justify-between text-sm text-gray-500 mt-1">
                    <span>Snippet (5s)</span>
                    <span>Full clip (60s)</span>
                </div>
            </div>

            {/* Loop */}
            <div className="mb-8">
                <label className="flex items-center space-x-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={loopClip}
                        onChange={(e) => {
                            setLoopClip(e.target.checked);
                            localStorage.setItem('quizLoopClip', e.target.checked);
                        }}
                        className="w-5 h-5 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500"
                    />
                    <span className="text-lg font-medium text-gray-700">Loop clip</span>
                    <span className="text-sm text-gray-500">(repeat until you submit your answer)</span>
                </label>
            </div>

            <button
                onClick={handleStart}
                disabled={loading}
                className="w-full py-4 bg-green-500 text-white text-xl font-bold rounded-lg hover:bg-green-600 transition disabled:opacity-50"
            >
                {loading ? 'Generating...' : "Let's Play!"}
            </button>
        </div>
    );
};

export default QuizSetupScreen;
