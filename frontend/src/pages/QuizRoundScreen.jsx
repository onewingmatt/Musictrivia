import { useState, useEffect, useMemo, useRef } from 'react';
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
    const [fuzzyThreshold, setFuzzyThreshold] = useState(0.25);
    const [hintVisible, setHintVisible] = useState(false);
    const [audioStarted, setAudioStarted] = useState(false);
    const [progress, setProgress] = useState(0);
    const playerRef = useRef(null);
    const playerDivRef = useRef(null);
    const stopTimerRef = useRef(null);
    const progressIntervalRef = useRef(null);
    const resolvedYtIdsRef = useRef(new Set());

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
                setFuzzyThreshold(s.fuzzyThreshold ?? 0.25);
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
                guessed_artist: guessedArtist,
                fuzzy_threshold: fuzzyThreshold
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

    // Lazy-resolve YouTube ID if not cached
    useEffect(() => {
        if (!currentQ || currentQ.audio_url || resolvedYtIdsRef.current.has(currentQ.id)) return;
        resolvedYtIdsRef.current.add(currentQ.id);
        api.post('/quiz/resolve-youtube', { song_id: currentQ.id })
            .then(res => {
                if (res.data.youtube_id) {
                    setQuestions(prev => prev.map((q, i) =>
                        i === currentIndex ? { ...q, audio_url: res.data.youtube_id } : q
                    ));
                }
            })
            .catch(() => {});
    }, [currentIndex, currentQ]);

    // Reset audio state when question changes
    useEffect(() => {
        setAudioStarted(false);
        setProgress(0);
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
        if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current);
            progressIntervalRef.current = null;
        }
        const vol = parseInt(localStorage.getItem('quizVolume') || '70');
        const startSec = randomStart && startOffsets[currentIndex] ? startOffsets[currentIndex] : 0;

        const createPlayer = () => {
            playerRef.current = new window.YT.Player(playerDivRef.current, {
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

                        const updateProgress = () => {
                            const player = playerRef.current;
                            if (!player || !player.getCurrentTime) return;
                            const elapsed = player.getCurrentTime() - startSec;
                            const p = Math.min(100, Math.max(0, (elapsed / clipDuration) * 100));
                            setProgress(p);
                        };
                        progressIntervalRef.current = setInterval(updateProgress, 100);

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
                                clearInterval(progressIntervalRef.current);
                                setProgress(100);
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
            if (progressIntervalRef.current) {
                clearInterval(progressIntervalRef.current);
                progressIntervalRef.current = null;
            }
            if (playerRef.current) {
                try { playerRef.current.destroy(); } catch {}
                playerRef.current = null;
            }
        };
    }, [currentIndex, questions.length, hasYoutube, youtubeId, randomStart, startOffsets, audioStarted, clipDuration, loopClip]);

    if (questions.length === 0) return <div className="text-center mt-20 dark:text-gray-300">Loading...</div>;

    return (
        <div className="max-w-2xl mx-auto mt-10 p-8 bg-white dark:bg-gray-900 rounded-xl shadow-md dark:shadow-gray-900/50">
            <div className="flex justify-between text-gray-500 dark:text-gray-400 mb-6 font-semibold">
                <span>Question {currentIndex + 1} of {questions.length}</span>
                <button
                    onClick={() => setHintVisible(v => !v)}
                    className="text-sm text-indigo-500 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 underline underline-offset-2"
                >
                    {hintVisible ? `${currentQ.genre !== 'Unknown' ? `${currentQ.genre} • ` : ''}${currentQ.decade}s` : 'Show hint'}
                </button>
            </div>

            <div className="mb-8 flex flex-col items-center gap-4">
                {hasYoutube ? (
                    <>
                        <div ref={playerDivRef} className="w-0 h-0 overflow-hidden" aria-hidden="true" />
                        {audioStarted ? (
                            <div className="w-full max-w-[400px]">
                                <div className="w-full h-[46px] bg-gray-900 dark:bg-gray-800 rounded-t-lg flex items-center justify-center gap-2">
                                    <span className="text-white text-sm">
                                        {progress >= 100 && !loopClip ? '\u23F8 Audio Finished' : '\u25B6 Playing clip...'}
                                    </span>
                                </div>
                                <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-b-lg overflow-hidden">
                                    <div 
                                        className="h-full bg-indigo-500 dark:bg-indigo-400 transition-all duration-100 ease-linear"
                                        style={{ width: `${progress}%` }}
                                    ></div>
                                </div>
                            </div>
                        ) : (
                            <button
                                onClick={() => setAudioStarted(true)}
                                className="w-[400px] h-[46px] bg-indigo-600 dark:bg-indigo-500 hover:bg-indigo-700 dark:hover:bg-indigo-600 rounded-lg flex items-center justify-center gap-2 text-white text-sm font-semibold transition"
                            >
                                &#9654; Tap to play audio
                            </button>
                        )}
                    </>
                ) : (
                    <div className="w-[400px] h-[46px] bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
                        No audio available for this track
                    </div>
                )}
            </div>

            {!feedback ? (
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Song Title</label>
                        <input
                            type="text"
                            value={guessedTitle}
                            onChange={e => setGuessedTitle(e.target.value)}
                            className="w-full p-3 border dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 focus:outline-none bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                            placeholder="Guess the song title..."
                            autoComplete="off"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">Artist</label>
                        <input
                            type="text"
                            value={guessedArtist}
                            onChange={e => setGuessedArtist(e.target.value)}
                            className="w-full p-3 border dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 focus:outline-none bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                            placeholder="Guess the artist..."
                            autoComplete="off"
                        />
                    </div>
                    <button type="submit" className="w-full py-3 bg-indigo-600 dark:bg-indigo-500 text-white font-bold rounded-lg hover:bg-indigo-700 dark:hover:bg-indigo-600 transition">
                        Submit Guess
                    </button>
                </form>
            ) : (
                <div className="space-y-6">
                    <div className={`p-4 rounded-lg ${feedback.points_awarded === 2 ? 'bg-green-100 dark:bg-green-900/30 border border-green-400 dark:border-green-600' : feedback.points_awarded === 1 ? 'bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-400 dark:border-yellow-600' : 'bg-red-100 dark:bg-red-900/30 border border-red-400 dark:border-red-600'}`}>
                        <h3 className="text-xl font-bold mb-2 text-gray-900 dark:text-gray-100">
                            {feedback.points_awarded === 2 ? 'Perfect!' : feedback.points_awarded === 1 ? 'Half Credit!' : 'Missed it!'}
                        </h3>
                        <p className="text-gray-800 dark:text-gray-200 text-lg">
                            The correct answer was <strong>"{feedback.actual_title}"</strong> by <strong>{feedback.actual_artist}</strong>.
                        </p>
                        <ul className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                            <li>Title Guess: {feedback.is_title_correct ? '\u2705' : '\u274C'}</li>
                            <li>Artist Guess: {feedback.is_artist_correct ? '\u2705' : '\u274C'}</li>
                        </ul>
                    </div>
                    <button onClick={handleNext} className="w-full py-3 bg-blue-600 dark:bg-blue-500 text-white font-bold rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition">
                        {currentIndex + 1 < questions.length ? 'Next Question' : 'View Results'}
                    </button>
                </div>
            )}
        </div>
    );
};

export default QuizRoundScreen;
