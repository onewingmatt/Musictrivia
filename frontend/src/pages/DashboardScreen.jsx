import React, { useState, useEffect, useContext } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import api from '../api';

const DashboardScreen = () => {
    const { user, logout } = useContext(AuthContext);
    const [stats, setStats] = useState(null);
    const navigate = useNavigate();

    const isGuest = user?.isGuest;

    useEffect(() => {
        if (isGuest) return; // guests don't have stats
        const fetchStats = async () => {
            try {
                const res = await api.get('/user/stats');
                setStats(res.data);
            } catch (err) {
                console.error("Failed to fetch stats", err);
            }
        };
        fetchStats();
    }, [isGuest]);

    return (
        <div className="max-w-4xl mx-auto mt-10 p-6 bg-white rounded-xl shadow-md">
            <div className="flex justify-between items-center mb-8 border-b pb-4">
                <h1 className="text-3xl font-bold text-gray-800">
                    Welcome{isGuest ? '' : `, ${user?.username}`}
                </h1>
                <button
                    onClick={() => { logout(); navigate('/login'); }}
                    className="text-gray-500 hover:text-red-500 transition"
                >
                    {isGuest ? 'Exit' : 'Log Out'}
                </button>
            </div>

            {isGuest && (
                <div className="mb-8 bg-amber-50 border border-amber-200 p-4 rounded-lg flex items-center justify-between">
                    <p className="text-amber-800 text-sm">
                        Playing as guest. <Link to="/login" className="underline font-medium">Log in</Link> or <Link to="/register" className="underline font-medium">sign up</Link> to track your stats and mastered songs.
                    </p>
                </div>
            )}

            {!isGuest && (
                <div className="grid grid-cols-2 gap-6 mb-10">
                    <div className="bg-blue-50 p-6 rounded-lg text-center">
                        <h3 className="text-gray-500 text-lg uppercase tracking-wide">Accuracy</h3>
                        <p className="text-5xl font-bold text-blue-600 mt-2">
                            {stats ? `${stats.accuracy_percentage}%` : '...'}
                        </p>
                    </div>
                    <div className="bg-green-50 p-6 rounded-lg text-center">
                        <h3 className="text-gray-500 text-lg uppercase tracking-wide">Songs Mastered</h3>
                        <p className="text-5xl font-bold text-green-600 mt-2">
                            {stats ? stats.mastered_songs_count : '...'}
                        </p>
                    </div>
                    <div className="bg-purple-50 p-6 rounded-lg text-center col-span-2">
                        <h3 className="text-gray-500 text-lg uppercase tracking-wide">Total Questions Answered</h3>
                        <p className="text-4xl font-bold text-purple-600 mt-2">
                            {stats ? stats.total_questions : '...'}
                        </p>
                    </div>
                </div>
            )}

            <div className="text-center">
                <button
                    onClick={() => navigate('/setup')}
                    className="px-8 py-4 bg-indigo-600 text-white text-xl font-bold rounded-full hover:bg-indigo-700 shadow-lg transform hover:scale-105 transition duration-200"
                >
                    Start New Quiz
                </button>
            </div>
        </div>
    );
};

export default DashboardScreen;