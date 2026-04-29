import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';

const ALL_GENRES = ["Pop", "Rock", "Hip Hop"];
const ALL_DECADES = [1960, 1970, 1980, 1990, 2000, 2010, 2020];

const QuizSetupScreen = () => {
    const navigate = useNavigate();
    const [genres, setGenres] = useState([]);
    const [decades, setDecades] = useState([]);
    const [popularity, setPopularity] = useState(50); // min popularity
    const [skipMastered, setSkipMastered] = useState(false);
    const [loading, setLoading] = useState(false);

    const toggleGenre = (g) => {
        setGenres(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]);
    };

    const toggleDecade = (d) => {
        setDecades(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);
    };

    const handleStart = async () => {
        setLoading(true);
        try {
            const res = await api.post('/quiz/generate', {
                genres,
                decades,
                skip_mastered: skipMastered,
                min_popularity: popularity,
                limit: 5 // hardcoded for standard round length
            });

            // Store questions in session storage to pass to the game screen
            sessionStorage.setItem('currentQuiz', JSON.stringify(res.data.questions));
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

            <div className="mb-6">
                <h3 className="text-lg font-semibold mb-3">Genres (Leave empty for all)</h3>
                <div className="flex flex-wrap gap-3">
                    {ALL_GENRES.map(g => (
                        <button
                            key={g}
                            onClick={() => toggleGenre(g)}
                            className={`px-4 py-2 rounded-full border transition ${genres.includes(g) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                        >
                            {g}
                        </button>
                    ))}
                </div>
            </div>

            <div className="mb-6">
                <h3 className="text-lg font-semibold mb-3">Decades (Leave empty for all)</h3>
                <div className="flex flex-wrap gap-3">
                    {ALL_DECADES.map(d => (
                        <button
                            key={d}
                            onClick={() => toggleDecade(d)}
                            className={`px-4 py-2 rounded-full border transition ${decades.includes(d) ? 'bg-pink-600 text-white border-pink-600' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                        >
                            {d}s
                        </button>
                    ))}
                </div>
            </div>

            <div className="mb-6">
                <h3 className="text-lg font-semibold mb-3">Minimum Popularity ({popularity})</h3>
                <input
                    type="range"
                    min="0" max="100"
                    value={popularity}
                    onChange={(e) => setPopularity(e.target.value)}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                />
                <div className="flex justify-between text-sm text-gray-500 mt-1">
                    <span>Obscure (0)</span>
                    <span>Hits Only (100)</span>
                </div>
            </div>

            <div className="mb-8">
                <label className="flex items-center space-x-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={skipMastered}
                        onChange={(e) => setSkipMastered(e.target.checked)}
                        className="w-5 h-5 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500"
                    />
                    <span className="text-lg font-medium text-gray-700">Skip songs I've already mastered</span>
                </label>
            </div>

            <button
                onClick={handleStart}
                disabled={loading}
                className="w-full py-4 bg-green-500 text-white text-xl font-bold rounded-lg hover:bg-green-600 transition disabled:opacity-50"
            >
                {loading ? 'Generating...' : 'Let\'s Play!'}
            </button>
        </div>
    );
};

export default QuizSetupScreen;