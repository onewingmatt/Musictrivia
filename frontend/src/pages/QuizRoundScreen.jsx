import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';

const QuizRoundScreen = () => {
    const navigate = useNavigate();
    const [questions, setQuestions] = useState([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [guessedTitle, setGuessedTitle] = useState('');
    const [guessedArtist, setGuessedArtist] = useState('');
    const [feedback, setFeedback] = useState(null);
    const [results, setResults] = useState([]);

    useEffect(() => {
        const stored = sessionStorage.getItem('currentQuiz');
        if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed.length === 0) {
                alert("No songs matched your filters.");
                navigate('/setup');
            } else {
                setQuestions(parsed);
            }
        } else {
            navigate('/setup');
        }
    }, [navigate]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        const currentQ = questions[currentIndex];
        try {
            const res = await api.post('/quiz/answer', {
                song_id: currentQ.id,
                guessed_title: guessedTitle,
                guessed_artist: guessedArtist
            });

            setFeedback(res.data);
            setResults(prev => [...prev, { question: currentQ, result: res.data }]);
        } catch (err) {
            console.error("Error submitting answer", err);
        }
    };

    const handleNext = () => {
        if (currentIndex + 1 < questions.length) {
            setCurrentIndex(prev => prev + 1);
            setGuessedTitle('');
            setGuessedArtist('');
            setFeedback(null);
        } else {
            sessionStorage.setItem('quizResults', JSON.stringify(results));
            navigate('/results');
        }
    };

    if (questions.length === 0) return <div className="text-center mt-20">Loading...</div>;

    const currentQ = questions[currentIndex];

    return (
        <div className="max-w-2xl mx-auto mt-10 p-8 bg-white rounded-xl shadow-md">
            <div className="flex justify-between text-gray-500 mb-6 font-semibold">
                <span>Question {currentIndex + 1} of {questions.length}</span>
                <span>{currentQ.genre} • {currentQ.decade}s</span>
            </div>

            <div className="mb-8 flex justify-center">
                {/* Mock Audio Player using embedded YouTube for scaffolding */}
                <iframe
                    width="400" height="200"
                    src={`https://www.youtube.com/embed/${currentQ.audio_url}?autoplay=0`}
                    title="Audio Player"
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen>
                </iframe>
            </div>

            {!feedback ? (
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-bold text-gray-700 mb-1">Song Title</label>
                        <input
                            type="text"
                            value={guessedTitle}
                            onChange={e => setGuessedTitle(e.target.value)}
                            className="w-full p-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                            placeholder="Guess the song title..."
                            autoComplete="off"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-bold text-gray-700 mb-1">Artist</label>
                        <input
                            type="text"
                            value={guessedArtist}
                            onChange={e => setGuessedArtist(e.target.value)}
                            className="w-full p-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                            placeholder="Guess the artist..."
                            autoComplete="off"
                        />
                    </div>
                    <button type="submit" className="w-full py-3 bg-indigo-600 text-white font-bold rounded-lg hover:bg-indigo-700 transition">
                        Submit Guess
                    </button>
                </form>
            ) : (
                <div className="space-y-6">
                    <div className={`p-4 rounded-lg ${feedback.points_awarded === 2 ? 'bg-green-100 border border-green-400' : feedback.points_awarded === 1 ? 'bg-yellow-100 border border-yellow-400' : 'bg-red-100 border border-red-400'}`}>
                        <h3 className="text-xl font-bold mb-2">
                            {feedback.points_awarded === 2 ? 'Perfect!' : feedback.points_awarded === 1 ? 'Half Credit!' : 'Missed it!'}
                        </h3>
                        <p className="text-gray-800 text-lg">
                            The correct answer was <strong>"{feedback.actual_title}"</strong> by <strong>{feedback.actual_artist}</strong>.
                        </p>
                        <ul className="mt-2 text-sm text-gray-600">
                            <li>Title Guess: {feedback.is_title_correct ? '✅' : '❌'}</li>
                            <li>Artist Guess: {feedback.is_artist_correct ? '✅' : '❌'}</li>
                        </ul>
                    </div>
                    <button onClick={handleNext} className="w-full py-3 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition">
                        {currentIndex + 1 < questions.length ? 'Next Question' : 'View Results'}
                    </button>
                </div>
            )}
        </div>
    );
};

export default QuizRoundScreen;