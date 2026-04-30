import React, { useState, useEffect, useMemo, useRef } from 'react';
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
    const [randomStart, setRandomStart] = useState(false);
    const [clipDuration, setClipDuration] = useState(15);
    const [loopClip, setLoopClip] = useState(false);
    const [hintVisible, setHintVisible] = useState(false);
    const [resolvingYoutube, setResolvingYoutube] = useState(false);
    const [audioStarted, setAudioStarted] = useState(false);
    const playerRef = useRef(null);
    const playerDivRef = useRef(null);
    const stopTimerRef = useRef(null);

    // Load YouTube IFrame API once
    useEffect(() => {
        if (window.YT) return;
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
    }, []);

    useEffect(() => {
        const stored = sessionStorage.getItem('currentQuiz');
        const settingsStr = sessionStorage.getItem('quizSettings');
        if (settingsStr) {
            try {
                const s = JSON.parse(settingsStr);
                setRandomStart(s.randomStart);
                setClipDuration(s.clipDuration || 15);
                setLoopClip(s.loopClip || false);
            } catch {}
        }
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

    // Memoize random start offsets per question so they don't change on re-render
    const startOffsets = useMemo(() => {
        if (!randomStart) return {};
        const offsets = {};
        questions.forEach((q, i) => {
            offsets[i] = Math.floor(Math.random() * 60) + 10; // 10-70 seconds
        });
        return offsets;
    }, [randomStart, questions.length]);

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
            setHintVisible(false);
        } else {
            sessionStorage.setItem('quizResults', JSON.stringify(results));
            navigate('/results');
        }
    };

    const currentQ = questions.length > 0 ? questions[currentIndex] : null;
    const youtubeId = currentQ?.audio_url;
    const hasYoutube = youtubeId && youtubeId.length === 11;

    // Reset audio state when question changes
    useEffect(() => {
        setAudioStarted(false);
    }, [currentIndex]);

    // Create/destroy YouTube player only after user taps play
    useEffect(() => {
        if (!hasYoutube || !currentQ || !audioStarted) return;
        if (playerRef.current) {
            try { playerRef.current.destroy(); } catch {}
            playerRef.current = null;
        }
        if (stopTimerRef.current) {
            clearInterval(stopTimerRef.current);
            stopTimerRef.current = null;
        }
        if (playerDivRef.current) {
            playerDivRef.current.innerHTML = '<div id="yt-player"></div>';
        }

        const vol = parseInt(localStorage.getItem('quizVolume') || '70');
        const startSec = randomStart && startOffsets[currentIndex] ? startOffsets[currentIndex] : 0;

        const createPlayer = () => {
            playerRef.current = new window.YT.Player('yt-player', {
                width: '1', height: '1',
                videoId: youtubeId,
                playerVars: {
                    autoplay: 1, controls: 0, modestbranding: 1,
                    rel: 0, fs: 0, iv_load_policy: 3, disablekb: 1,
                    start: startSec
                },
                events: {
                    onReady: (e) => {
                        e.target.setVolume(vol);
                        e.target.playVideo();

                        if (loopClip) {
                            // Poll and loop: seek back to start when clip duration elapsed
                            const checkLoop = () => {
                                const player = playerRef.current;
                                if (!player || !player.getCurrentTime) return;
                                const elapsed = player.getCurrentTime() - startSec;
                                if (elapsed >= clipDuration) {
                                    player.seekTo(startSec, true);
                                    player.playVideo();
                                }
                            };
                            stopTimerRef.current = setInterval(checkLoop, 500);
                        } else {
                            // Stop after clip duration
                            stopTimerRef.current = setTimeout(() => {
                                if (playerRef.current && playerRef.current.pauseVideo) {
                                    playerRef.current.pauseVideo();
                                }
                                stopTimerRef.current = null;
                            }, clipDuration * 1000);
                        }
                    }
                }
            });
        };

        if (window.YT && window.YT.Player) {
            createPlayer();
        } else {
            const check = setInterval(() => {
                if (window.YT && window.YT.Player) {
                    clearInterval(check);
                    createPlayer();
                }
            }, 100);
            return () => clearInterval(check);
        }
        return () => {
            if (stopTimerRef.current) {
                clearInterval(stopTimerRef.current);
                clearTimeout(stopTimerRef.current);
                stopTimerRef.current = null;
            }
            if (playerRef.current) {
                try { playerRef.current.destroy(); } catch {}
                playerRef.current = null;
            }
        };
    }, [currentIndex, questions.length, hasYoutube, youtubeId, randomStart, startOffsets, audioStarted, clipDuration, loopClip]);

    if (questions.length === 0) return <div className="text-center mt-20">Loading...</div>;

    return (
        <div className="max-w-2xl mx-auto mt-10 p-8 bg-white rounded-xl shadow-md">
            <div className="flex justify-between text-gray-500 mb-6 font-semibold">
                <span>Question {currentIndex + 1} of {questions.length}</span>
                <button
                    onClick={() => setHintVisible(v => !v)}
                    className="text-sm text-indigo-500 hover:text-indigo-700 underline underline-offset-2"
                >
                    {hintVisible ? `${currentQ.genre !== 'Unknown' ? `${currentQ.genre} • ` : ''}${currentQ.decade}s` : 'Show hint'}
                </button>
            </div>

            <div className="mb-8 flex justify-center">
                {hasYoutube ? (
                    <>
                        <div ref={playerDivRef} style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}>
                            <div id="yt-player"></div>
                        </div>
                        {audioStarted ? (
                            <div className="w-[400px] h-[46px] bg-gray-900 rounded-lg flex items-center justify-center gap-2">
                                <span className="text-white text-sm">&#9654; Playing audio...</span>
                            </div>
                        ) : (
                            <button
                                onClick={() => setAudioStarted(true)}
                                className="w-[400px] h-[46px] bg-indigo-600 hover:bg-indigo-700 rounded-lg flex items-center justify-center gap-2 text-white text-sm font-semibold transition"
                            >
                                &#9654; Tap to play audio
                            </button>
                        )}
                    </>
                ) : (
                    <div className="w-[400px] h-[46px] bg-gray-100 rounded-lg flex items-center justify-center text-gray-400 text-sm">
                        No audio available for this track
                    </div>
                )}
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
                            <li>Title Guess: {feedback.is_title_correct ? '\u2705' : '\u274C'}</li>
                            <li>Artist Guess: {feedback.is_artist_correct ? '\u2705' : '\u274C'}</li>
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
