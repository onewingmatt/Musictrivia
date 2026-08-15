import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';

const ALL_GENRES = [
    "Pop", "Rock", "Hip Hop", "R&B", "Country", "Electronic",
    "Indie", "Alternative", "Jazz", "Blues", "Folk", "Metal",
    "Punk", "Funk", "Disco", "Latin", "K-Pop", "Singer-Songwriter",
    "Reggae", "Gospel", "Classical"
];
const ALL_DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];
const ALL_SOURCES = [
    { id: 'billboard-us', label: 'Billboard Hot 100 (US)', color: 'emerald' },
    { id: 'billboard-canada', label: 'Canadian Hot 100', color: 'red' },
    { id: 'wikipedia-canada-number-ones', label: 'Canadian #1s (Pre-2007)', color: 'blue' },
];

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
    const [sourceWeights, setSourceWeights] = useState(() => {
        const initial = {};
        ALL_SOURCES.forEach(s => initial[s.id] = 0);
        return initial;
    });
    const [popularityRange, setPopularityRange] = useState([50, 100]);
    const [market, setMarket] = useState('us');
    const [skipMastered, setSkipMastered] = useState(false);
    const [randomStart, setRandomStart] = useState(false);
    const [questionCount, setQuestionCount] = useState(5);
    const [fuzzyThreshold, setFuzzyThreshold] = useState(0.25);
    const [loading, setLoading] = useState(false);
    const [genreCounts, setGenreCounts] = useState({});
    const [decadeCounts, setDecadeCounts] = useState({});
    const [sourceCounts, setSourceCounts] = useState({});
    const [savedConfigs, setSavedConfigs] = useState([]);
    const [newConfigName, setNewConfigName] = useState('');
    const [volume, setVolume] = useState(() => parseInt(localStorage.getItem('quizVolume') || '70'));
    const [clipDuration, setClipDuration] = useState(() => parseInt(localStorage.getItem('quizClipDuration') || '15'));
    const [loopClip, setLoopClip] = useState(() => localStorage.getItem('quizLoopClip') === 'true');

    useEffect(() => {
        api.get('/quiz/genres').then(res => {
            const counts = {};
            res.data.genres.forEach(g => counts[g.genre] = g.count);
            setGenreCounts(counts);
        }).catch(() => {});

        api.get('/quiz/decades').then(res => {
            const counts = {};
            res.data.decades.forEach(d => counts[d.decade] = d.count);
            setDecadeCounts(counts);
        }).catch(() => {});

        api.get('/quiz/sources').then(res => {
            const counts = {};
            res.data.sources.forEach(s => counts[s.source] = s.song_count);
            setSourceCounts(counts);
        }).catch(() => {});

        api.get('/quiz/configs').then(res => {
            setSavedConfigs(res.data.configs);
        }).catch(() => {});
    }, []);

    const handleSaveConfig = async () => {
        if (!newConfigName.trim()) return;
        try {
            const config = {
                genreWeights,
                decadeWeights,
                sourceWeights,
                popularityRange,
                market,
                skipMastered,
                randomStart,
                questionCount,
                fuzzyThreshold,
                clipDuration,
                loopClip
            };
            const res = await api.post('/quiz/configs', { name: newConfigName, config });
            setSavedConfigs(prev => [res.data, ...prev]);
            setNewConfigName('');
        } catch (err) {
            console.error("Error saving config", err);
            if (err.response?.status === 401) {
                alert("Log in to save presets.");
            } else {
                alert("Failed to save configuration.");
            }
        }
    };

    const loadConfig = (c) => {
        const { config } = c;
        if (config.genreWeights) setGenreWeights(config.genreWeights);
        if (config.decadeWeights) setDecadeWeights(config.decadeWeights);
        if (config.sourceWeights) setSourceWeights(config.sourceWeights);
        if (config.popularityRange) setPopularityRange(config.popularityRange);
        if (config.market) setMarket(config.market);
        if (config.skipMastered !== undefined) setSkipMastered(config.skipMastered);
        if (config.randomStart !== undefined) setRandomStart(config.randomStart);
        if (config.questionCount) setQuestionCount(config.questionCount);
        if (config.fuzzyThreshold !== undefined) setFuzzyThreshold(config.fuzzyThreshold);
        if (config.clipDuration) setClipDuration(config.clipDuration);
        if (config.loopClip !== undefined) setLoopClip(config.loopClip);
    };

    const deleteConfig = async (id) => {
        try {
            await api.delete(`/quiz/configs/${id}`);
            setSavedConfigs(prev => prev.filter(c => c.id !== id));
        } catch (err) {
            console.error("Error deleting config", err);
        }
    };

    const setAllGenres = (value) => {
        const next = {};
        ALL_GENRES.forEach(g => next[g] = value);
        setGenreWeights(next);
    };

    const setAllDecades = (value) => {
        const next = {};
        ALL_DECADES.forEach(d => next[d] = value);
        setDecadeWeights(next);
    };

    const setAllSources = (value) => {
        const next = {};
        ALL_SOURCES.forEach(s => next[s.id] = value);
        setSourceWeights(next);
    };

    const activeGenreCount = Object.values(genreWeights).filter(w => w > 0).length;
    const activeDecadeCount = Object.values(decadeWeights).filter(w => w > 0).length;
    const activeSourceCount = Object.values(sourceWeights).filter(w => w > 0).length;

    const handleStart = async () => {
        setLoading(true);
        try {
            const activeDecades = Object.entries(decadeWeights)
                .filter(([, w]) => w > 0)
                .map(([d]) => parseInt(d));

            const res = await api.post('/quiz/generate', {
                genre_weights: genreWeights,
                decade_weights: decadeWeights,
                source_weights: sourceWeights,
                decades: activeDecades,
                skip_mastered: skipMastered,
                exclude_song_ids: JSON.parse(localStorage.getItem('excludeSongIds') || '[]'),
                min_popularity: popularityRange[0],
                max_popularity: popularityRange[1],
                market,
                limit: questionCount
            });

            if (res.data.questions.length === 0) {
                alert("No songs matched your filters. Try adjusting genres, sources, or popularity.");
                setLoading(false);
                return;
            }

            sessionStorage.setItem('currentQuiz', JSON.stringify(res.data.questions));
            sessionStorage.setItem('quizSettings', JSON.stringify({ randomStart, clipDuration, loopClip, fuzzyThreshold }));
            // Keep the filter payload so a stalled song can be replaced with a
            // fresh pick using the same settings (without restarting the round).
            sessionStorage.setItem('quizFilters', JSON.stringify({
                genre_weights: genreWeights,
                decade_weights: decadeWeights,
                source_weights: sourceWeights,
                decades: activeDecades,
                skip_mastered: skipMastered,
                min_popularity: popularityRange[0],
                max_popularity: popularityRange[1],
                market,
            }));
            navigate('/play');
        } catch (err) {
            console.error("Error generating quiz", err);
            alert("Failed to generate quiz. Do you have enough matching songs?");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="max-w-3xl mx-auto mt-10 p-8 bg-white dark:bg-gray-800 rounded-xl shadow-md">
            <h1 className="text-3xl font-bold mb-6 border-b pb-4 dark:border-gray-700">Configure Your Quiz</h1>

            {/* Saved Configurations */}
            <div className="mb-8 p-4 bg-gray-50 dark:bg-gray-700/50 rounded-xl border border-gray-200 dark:border-gray-600">
                <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                    <svg className="w-5 h-5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
                    Saved Presets
                </h3>
                
                {savedConfigs.length > 0 ? (
                    <div className="flex flex-wrap gap-2 mb-4">
                        {savedConfigs.map(c => (
                            <div key={c.id} className="group flex items-center">
                                <button
                                    onClick={() => loadConfig(c)}
                                    className="px-3 py-1.5 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-l-lg text-sm font-medium dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 hover:border-indigo-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                                >
                                    {c.name}
                                </button>
                                <button
                                    onClick={() => deleteConfig(c.id)}
                                    className="px-2 py-1.5 bg-white dark:bg-gray-700 border-y border-r border-gray-300 dark:border-gray-600 rounded-r-lg text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition"
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                                </button>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-gray-500 dark:text-gray-400 dark:text-gray-400 mb-4 italic">No saved presets yet.</p>
                )}

                <div className="flex gap-2">
                    <input
                        type="text"
                        placeholder="Preset name (e.g. 80s Pop)"
                        value={newConfigName}
                        onChange={(e) => setNewConfigName(e.target.value)}
                        className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                    />
                    <button
                        onClick={handleSaveConfig}
                        disabled={!newConfigName.trim()}
                        className="px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition"
                    >
                        Save Current
                    </button>
                </div>
            </div>

            {/* Chart Source Sliders */}
            <details className="mb-6 group" open={activeSourceCount > 0}>
                <summary className="flex items-center justify-between cursor-pointer select-none list-none">
                    <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-gray-400 dark:text-gray-500 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
                        <h3 className="text-lg font-semibold">Chart Sources</h3>
                        {activeSourceCount > 0 && (
                            <span className="text-xs bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 rounded-full">{activeSourceCount} active</span>
                        )}
                    </div>
                    <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                        <button
                            onClick={() => setAllSources(0)}
                            className="text-xs px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                        >
                            Clear All
                        </button>
                        <button
                            onClick={() => setAllSources(3)}
                            className="text-xs px-3 py-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-800"
                        >
                            Equal Mix
                        </button>
                    </div>
                </summary>
                <div className="mt-3">
                    <p className="text-sm text-gray-500 dark:text-gray-400 dark:text-gray-400 mb-4">
                        Weight chart sources. Higher = more songs from that chart. Songs on multiple charts get blended popularity.
                    </p>
                    <div className="space-y-3">
                        {ALL_SOURCES.map(src => {
                            const count = sourceCounts[src.id] || 0;
                            return (
                                <div key={src.id} className="flex items-center gap-3">
                                    <span className="w-52 text-sm font-medium text-gray-700 dark:text-gray-300 flex justify-between">
                                        <span>{src.label}</span>
                                        <span className="text-gray-400 dark:text-gray-500 text-xs">({count})</span>
                                    </span>
                                    <input
                                        type="range"
                                        min="0" max="5" step="1"
                                        value={sourceWeights[src.id]}
                                        onChange={(e) => setSourceWeights(prev => ({...prev, [src.id]: parseInt(e.target.value)}))}
                                        className="flex-1 h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                                    />
                                    <span className="w-6 text-center text-sm font-mono text-gray-500 dark:text-gray-400">
                                        {sourceWeights[src.id] > 0 ? sourceWeights[src.id] : '-'}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                    {activeSourceCount === 0 && (
                        <p className="mt-2 text-amber-600 dark:text-amber-400 text-sm">No sources selected — all sources included equally.</p>
                    )}
                </div>
            </details>

            {/* Genre Weight Sliders */}
            <details className="mb-6 group" open={activeGenreCount > 0}>
                <summary className="flex items-center justify-between cursor-pointer select-none list-none">
                    <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-gray-400 dark:text-gray-500 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
                        <h3 className="text-lg font-semibold">Genre Mix</h3>
                        {activeGenreCount > 0 && (
                            <span className="text-xs bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 px-2 py-0.5 rounded-full">{activeGenreCount} active</span>
                        )}
                    </div>
                    <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                        <button
                            onClick={() => setAllGenres(0)}
                            className="text-xs px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                        >
                            Clear All
                        </button>
                        <button
                            onClick={() => setAllGenres(3)}
                            className="text-xs px-3 py-1 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-200 dark:hover:bg-indigo-800"
                        >
                            Equal Mix
                        </button>
                    </div>
                </summary>
                <div className="mt-3">
                    <p className="text-sm text-gray-500 dark:text-gray-400 dark:text-gray-400 mb-4">
                        Set how much of each genre you want. Higher = more likely to appear. Leave at 0 to exclude.
                    </p>
                    <div className="space-y-3">
                        {ALL_GENRES.map(genre => {
                            const count = genreCounts[genre] || 0;
                            if (count === 0 && genreWeights[genre] === 0) return null;
                            return (
                                <div key={genre} className="flex items-center gap-3">
                                    <span className="w-36 text-sm font-medium text-gray-700 dark:text-gray-300 flex justify-between">
                                        <span>{genre}</span>
                                        <span className="text-gray-400 dark:text-gray-500 text-xs">({count})</span>
                                    </span>
                                    <input
                                        type="range"
                                        min="0" max="5" step="1"
                                        value={genreWeights[genre]}
                                        onChange={(e) => setGenreWeights(prev => ({...prev, [genre]: parseInt(e.target.value)}))}
                                        className="flex-1 h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                                    />
                                    <span className="w-6 text-center text-sm font-mono text-gray-500 dark:text-gray-400">
                                        {genreWeights[genre] > 0 ? genreWeights[genre] : '-'}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                    {activeGenreCount === 0 && (
                        <p className="mt-2 text-amber-600 dark:text-amber-400 text-sm">No genres selected — all genres will be included equally.</p>
                    )}
                </div>
            </details>

            {/* Decade Weight Sliders */}
            <details className="mb-6 group" open={activeDecadeCount > 0}>
                <summary className="flex items-center justify-between cursor-pointer select-none list-none">
                    <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-gray-400 dark:text-gray-500 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
                        <h3 className="text-lg font-semibold">Decade Mix</h3>
                        {activeDecadeCount > 0 && (
                            <span className="text-xs bg-pink-100 dark:bg-pink-900/40 text-pink-700 dark:text-pink-300 px-2 py-0.5 rounded-full">{activeDecadeCount} active</span>
                        )}
                    </div>
                    <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                        <button
                            onClick={() => setAllDecades(0)}
                            className="text-xs px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                        >
                            Clear All
                        </button>
                        <button
                            onClick={() => setAllDecades(3)}
                            className="text-xs px-3 py-1 rounded-full bg-pink-100 dark:bg-pink-900/40 text-pink-700 dark:text-pink-300 hover:bg-pink-200 dark:hover:bg-pink-800"
                        >
                            Equal Mix
                        </button>
                    </div>
                </summary>
                <div className="mt-3">
                    <p className="text-sm text-gray-500 dark:text-gray-400 dark:text-gray-400 mb-4">
                        Set how much of each decade you want. Higher = more likely to appear. Leave at 0 to exclude.
                    </p>
                    <div className="space-y-3">
                        {ALL_DECADES.map(decade => (
                            <div key={decade} className="flex items-center gap-3">
                                <span className="w-36 text-sm font-medium text-gray-700 dark:text-gray-300 flex justify-between">
                                    <span>{decade}s</span>
                                    <span className="text-gray-400 dark:text-gray-500 text-xs">({decadeCounts[decade] || 0})</span>
                                </span>
                                <input
                                    type="range"
                                    min="0" max="5" step="1"
                                    value={decadeWeights[decade]}
                                    onChange={(e) => setDecadeWeights(prev => ({...prev, [decade]: parseInt(e.target.value)}))}
                                    className="flex-1 h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-pink-600"
                                />
                                <span className="w-6 text-center text-sm font-mono text-gray-500 dark:text-gray-400">
                                    {decadeWeights[decade] > 0 ? decadeWeights[decade] : '-'}
                                </span>
                            </div>
                        ))}
                    </div>
                    {activeDecadeCount === 0 && (
                        <p className="mt-2 text-amber-600 dark:text-amber-400 text-sm">No decades selected — all decades will be included equally.</p>
                    )}
                </div>
            </details>

            {/* Popularity Range */}
            <div className="mb-6">
                <h3 className="text-lg font-semibold mb-1">Popularity ({popularityRange[0]} – {popularityRange[1]})</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                    Based on chart performance: peak position + weeks on chart + weeks at #1.
                </p>
                <div className="flex gap-4 items-center">
                    <div className="flex-1">
                        <label className="text-xs text-gray-500 dark:text-gray-400">Min</label>
                        <input
                            type="range"
                            min="0" max="100"
                            value={popularityRange[0]}
                            onChange={(e) => setPopularityRange(prev => [Math.min(parseInt(e.target.value), prev[1]), prev[1]])}
                            className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                        />
                    </div>
                    <div className="flex-1">
                        <label className="text-xs text-gray-500 dark:text-gray-400">Max</label>
                        <input
                            type="range"
                            min="0" max="100"
                            value={popularityRange[1]}
                            onChange={(e) => setPopularityRange(prev => [prev[0], Math.max(parseInt(e.target.value), prev[0])])}
                            className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                        />
                    </div>
                </div>
                <div className="flex justify-between text-sm text-gray-500 dark:text-gray-400 mt-1">
                    <span>Obscure (0)</span>
                    <span>Hits Only (100)</span>
                </div>
            </div>

            {/* Chart Market toggle */}
            <div className="mb-6">
                <h3 className="text-lg font-semibold mb-1">Chart Market</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                    Which country's charts drive the popularity filter above.
                </p>
                <div className="flex gap-2 p-1 bg-gray-100 dark:bg-gray-700 rounded-lg max-w-sm">
                    {[
                        { label: 'US', value: 'us', desc: 'Billboard Hot 100' },
                        { label: 'Canada', value: 'ca', desc: 'Canadian charts' }
                    ].map((opt) => (
                        <button
                            key={opt.value}
                            onClick={() => setMarket(opt.value)}
                            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition ${
                                market === opt.value
                                    ? 'bg-white dark:bg-gray-600 text-indigo-600 dark:text-indigo-300 shadow-sm'
                                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                            }`}
                        >
                            <div className="font-bold">{opt.label}</div>
                            <div className="text-[10px] opacity-75">{opt.desc}</div>
                        </button>
                    ))}
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
                    className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                />
                <div className="flex justify-between text-sm text-gray-500 dark:text-gray-400 mt-1">
                    <span>Quick (3)</span>
                    <span>Marathon (20)</span>
                </div>
            </div>

            {/* Spelling Strictness */}
            <div className="mb-6">
                <h3 className="text-lg font-semibold mb-1">Spelling Strictness</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                    How close does your answer need to be?
                </p>
                <div className="flex gap-2 p-1 bg-gray-100 dark:bg-gray-700 rounded-lg">
                    {[
                        { label: 'Strict', value: 0, desc: 'Exact match only' },
                        { label: 'Normal', value: 0.25, desc: 'Allow minor typos' },
                        { label: 'Lenient', value: 0.5, desc: 'Very forgiving' }
                    ].map((opt) => (
                        <button
                            key={opt.label}
                            onClick={() => setFuzzyThreshold(opt.value)}
                            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition ${
                                fuzzyThreshold === opt.value
                                    ? 'bg-white dark:bg-gray-600 text-indigo-600 dark:text-indigo-300 shadow-sm'
                                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                            }`}
                        >
                            <div className="font-bold">{opt.label}</div>
                            <div className="text-[10px] opacity-75">{opt.desc}</div>
                        </button>
                    ))}
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
                    <span className="text-lg font-medium text-gray-700 dark:text-gray-300">Skip songs I've already mastered</span>
                </label>
                <label className="flex items-center space-x-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={randomStart}
                        onChange={(e) => setRandomStart(e.target.checked)}
                        className="w-5 h-5 text-purple-600 rounded border-gray-300 focus:ring-purple-500"
                    />
                    <span className="text-lg font-medium text-gray-700 dark:text-gray-300">Random start point</span>
                    <span className="text-sm text-gray-500 dark:text-gray-400">(song plays from a random point)</span>
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
                    className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                />
                <div className="flex justify-between text-sm text-gray-500 dark:text-gray-400 mt-1">
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
                    className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                />
                <div className="flex justify-between text-sm text-gray-500 dark:text-gray-400 mt-1">
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
                    <span className="text-lg font-medium text-gray-700 dark:text-gray-300">Loop clip</span>
                    <span className="text-sm text-gray-500 dark:text-gray-400">(repeat until you submit your answer)</span>
                </label>
            </div>

            {/* Excluded songs tracker */}
            <div className="mb-4 flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
                <span>
                    Excluded recent songs: {JSON.parse(localStorage.getItem('excludeSongIds') || '[]').length}
                </span>
                <button
                    onClick={() => {
                        localStorage.removeItem('excludeSongIds');
                        window.location.reload();
                    }}
                    className="text-red-500 hover:text-red-700 underline text-xs"
                >
                    Clear history
                </button>
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
