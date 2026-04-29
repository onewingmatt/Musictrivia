import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const ResultsScreen = () => {
    const navigate = useNavigate();
    const [results, setResults] = useState([]);

    useEffect(() => {
        const stored = sessionStorage.getItem('quizResults');
        if (stored) {
            setResults(JSON.parse(stored));
        } else {
            navigate('/dashboard');
        }
    }, [navigate]);

    const totalPoints = results.reduce((sum, r) => sum + r.result.points_awarded, 0);
    const maxPoints = results.length * 2;

    return (
        <div className="max-w-3xl mx-auto mt-10 p-8 bg-white rounded-xl shadow-md">
            <h1 className="text-4xl font-bold mb-2 text-center">Round Complete!</h1>
            <p className="text-center text-gray-600 mb-8 text-xl">You scored {totalPoints} out of {maxPoints} points.</p>

            <div className="space-y-4 mb-8">
                {results.map((item, idx) => (
                    <div key={idx} className="p-4 border rounded-lg flex justify-between items-center bg-gray-50">
                        <div>
                            <p className="font-bold text-lg">{item.result.actual_title}</p>
                            <p className="text-gray-600">{item.result.actual_artist}</p>
                        </div>
                        <div className="text-right">
                            <span className="inline-block px-3 py-1 rounded-full text-sm font-bold text-white bg-blue-500">
                                +{item.result.points_awarded} pts
                            </span>
                        </div>
                    </div>
                ))}
            </div>

            <button
                onClick={() => navigate('/dashboard')}
                className="w-full py-4 bg-indigo-600 text-white text-xl font-bold rounded-lg hover:bg-indigo-700 transition"
            >
                Return to Dashboard
            </button>
        </div>
    );
};

export default ResultsScreen;