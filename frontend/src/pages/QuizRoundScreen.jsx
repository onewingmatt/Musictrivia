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
    const [resolvingAudio, setResolvingAudio] = useState(false);
    const [audioResolveError, setAudioResolveError] = useState('');
    const [audioLookupNonce, setAudioLookupNonce] = useState(0);
    const [playerPaused, setPlayerPaused] = useState(false);
    const [volume, setVolume] = useState(() => parseInt(localStorage.getItem('quizVolume') || '70'));
    const playerRef = useRef(null);
    const playerDivRef = useRef(null);
    const stopTimerRef = useRef(null);
    const progressIntervalRef = useRef(null);
    const resolvedYtIdsRef = useRef(new Set());
    const resolvingYtIdsRef = useRef(new Set());
    const pendingPlayRef = useRef(false);

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

    const isIOS = useMemo(() => {
        if (typeof navigator === 'undefined') return false;
        const ua = navigator.userAgent || '';
        return /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }, []);

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

    const advanceToNextQuestion = (nextResults = results) => {
        if (currentIndex + 1 < questions.length) {
            setCurrentIndex(prev => prev + 1);
            setGuessedTitle('');
            setGuessedArtist('');
            setFeedback(null);
            setHintVisible(false);
            return;
        }

        sessionStorage.setItem('quizResults', JSON.stringify(nextResults));
        navigate('/results');
    };

    const retryAudioLookup = () => {
        if (!currentQ) return;
        resolvingYtIdsRef.current.delete(currentQ.id);
        resolvedYtIdsRef.current.delete(currentQ.id);
        setAudioResolveError('');
        setResolvingAudio(false);
        setAudioLookupNonce(prev => prev + 1);
    };

    const handleSkipBrokenSong = async () => {
        if (!currentQ) return;

        try {
            const res = await api.post('/quiz/answer', {
                song_id: currentQ.id,
                guessed_title: '',
                guessed_artist: '',
                fuzzy_threshold: fuzzyThreshold
            });

            const nextResults = [...results, {
                question: currentQ,
                result: {
                    ...res.data,
                    skipped_audio: true,
                },
            }];

            setResults(nextResults);
            advanceToNextQuestion(nextResults);
        } catch (err) {
            console.error('Error skipping broken song', err);
        }
    };

    const handleVolumeChange = (nextVolume) => {
        setVolume(nextVolume);
        localStorage.setItem('quizVolume', String(nextVolume));
        if (playerRef.current?.setVolume) {
            try { playerRef.current.setVolume(nextVolume); } catch {}
        }
    };

    const togglePausePlayback = () => {
        const player = playerRef.current;
        if (!player) return;

        try {
            if (playerPaused) {
                player.playVideo?.();
                setPlayerPaused(false);
            } else {
                player.pauseVideo?.();
                setPlayerPaused(true);
            }
        } catch (err) {
            console.error('Failed to toggle playback', err);
        }
    };

    const currentQ = questions.length > 0 ? questions[currentIndex] : null;
    const youtubeId = currentQ?.audio_url;
    const hasYoutube = youtubeId && youtubeId.length === 11;

    const startAudioPlayback = () => {
        if (!hasYoutube || !currentQ) return;
        if (pendingPlayRef.current) {
            clearInterval(pendingPlayRef.current);
            pendingPlayRef.current = null;
        }
        if (playerRef.current) {
            try { playerRef.current.destroy(); } catch {}
            playerRef.current = null;
        }
        if (stopTimerRef.current) {
            clearInterval(stopTimerRef.current);
            clearTimeout(stopTimerRef.current);
            stopTimerRef.current = null;
        }
        if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current);
            progressIntervalRef.current = null;
        }
        const vol = volume;
        const startSec = randomStart && startOffsets[currentIndex] ? startOffsets[currentIndex] : 0;

        const attachPlayer = () => {
            playerRef.current = new window.YT.Player(playerDivRef.current, {
                width: '1', height: '1',
                videoId: youtubeId,
                playerVars: {
                    autoplay: 1, controls: 0, modestbranding: 1,
                    rel: 0, fs: 0, iv_load_policy: 3, disablekb: 1,
                    playsinline: 1,
                    origin: window.location.origin,
                    start: startSec
                },
                events: {
                    onReady: (e) => {
                        try { e.target.mute(); } catch {}
                        try { e.target.setVolume(vol); } catch {}
                        try { e.target.playVideo(); } catch {}
                    },
                    onStateChange: (ev) => {
                        if (ev.data === window.YT.PlayerState.PLAYING) {
                            setPlayerPaused(false);
                            try { ev.target.unMute(); } catch {}
                            try { ev.target.setVolume(vol); } catch {}

                            const updateProgress = () => {
                                const player = playerRef.current;
                                if (!player || !player.getCurrentTime) return;
                                const elapsed = player.getCurrentTime() - startSec;
                                const p = Math.min(100, Math.max(0, (elapsed / clipDuration) * 100));
                                setProgress(p);
                            };
                            progressIntervalRef.current = setInterval(updateProgress, 100);

                            const checkClipEnd = () => {
                                const player = playerRef.current;
                                if (!player || !player.getCurrentTime) return;
                                const elapsed = player.getCurrentTime() - startSec;
                                if (elapsed >= clipDuration) {
                                    if (loopClip) {
                                        player.seekTo(startSec, true);
                                        player.playVideo();
                                        return;
                                    }
                                    player.pauseVideo();
                                    clearInterval(progressIntervalRef.current);
                                    setProgress(100);
                                    setPlayerPaused(true);
                                    if (stopTimerRef.current) {
                                        clearInterval(stopTimerRef.current);
                                    }
                                    stopTimerRef.current = null;
                                }
                            };
                            stopTimerRef.current = setInterval(checkClipEnd, 250);
                        } else if (ev.data === window.YT.PlayerState.PAUSED) {
                            setPlayerPaused(true);
                        } else if (ev.data === window.YT.PlayerState.ENDED) {
                            setPlayerPaused(false);
                            setProgress(100);
                        }
                    },
                    onError: () => {
                        setAudioStarted(false);
                        setResolvingAudio(false);
                    }
                }
            });
        };

        if (window.YT && window.YT.Player) {
            attachPlayer();
            return;
        }

        const check = setInterval(() => {
            if (window.YT && window.YT.Player) {
                clearInterval(check);
                attachPlayer();
            }
        }, 100);
        pendingPlayRef.current = check;
    };

    // Lazy-resolve YouTube ID if not cached
    useEffect(() => {
        if (!currentQ || currentQ.audio_url) return;
        if (resolvedYtIdsRef.current.has(currentQ.id) || resolvingYtIdsRef.current.has(currentQ.id)) return;

        let cancelled = false;

        resolvingYtIdsRef.current.add(currentQ.id);
        setResolvingAudio(true);
        setAudioResolveError('');

        api.post('/quiz/resolve-youtube', { song_id: currentQ.id }, { timeout: 15000 })
            .then(res => {
                if (cancelled) return;

                if (res.data.youtube_id) {
                    resolvedYtIdsRef.current.add(currentQ.id);
                    setQuestions(prev => prev.map((q, i) =>
                        i === currentIndex ? { ...q, audio_url: res.data.youtube_id } : q
                    ));
                    return;
                }

                setAudioResolveError('Audio lookup returned no playable result for this song.');
            })
            .catch((err) => {
                if (cancelled) return;

                if (err?.code === 'ECONNABORTED') {
                    setAudioResolveError('Audio lookup timed out. You can retry or skip this song.');
                } else {
                    setAudioResolveError('Audio lookup failed. You can retry or skip this song.');
                }
            })
            .finally(() => {
                resolvingYtIdsRef.current.delete(currentQ.id);
                if (!cancelled) {
                    setResolvingAudio(false);
                }
            });

        return () => {
            cancelled = true;
            resolvingYtIdsRef.current.delete(currentQ.id);
        };
    }, [currentIndex, currentQ, audioLookupNonce]);

    // Reset audio state when question changes
    useEffect(() => {
        setAudioStarted(false);
        setProgress(0);
        setAudioResolveError('');
        setPlayerPaused(false);
    }, [currentIndex]);

    // Cleanup old player/timers when the question changes.
    useEffect(() => {
        setAudioStarted(false);
        setProgress(0);
        if (stopTimerRef.current) {
            clearInterval(stopTimerRef.current);
            clearTimeout(stopTimerRef.current);
            stopTimerRef.current = null;
        }
        if (progressIntervalRef.current) {
            clearInterval(progressIntervalRef.current);
            progressIntervalRef.current = null;
        }
        if (pendingPlayRef.current) {
            clearInterval(pendingPlayRef.current);
            pendingPlayRef.current = null;
        }
        if (playerRef.current) {
            try { playerRef.current.destroy(); } catch {}
            playerRef.current = null;
        }
    }, [currentIndex]);

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
                        {!isIOS && <div ref={playerDivRef} className="absolute left-0 top-0 w-px h-px opacity-0 pointer-events-none" aria-hidden="true" />}
                        {isIOS ? (
                            <div className="w-full max-w-[400px] space-y-3">
                                <div className="text-sm text-gray-600 dark:text-gray-300 text-center">
                                    Use the YouTube play button below on iPhone.
                                </div>
                                <div className="relative w-full overflow-hidden rounded-lg bg-black">
                                    <iframe
                                        key={`${currentQ.id}-${startOffsets[currentIndex] || 0}`}
                                        width="400"
                                        height="230"
                                        src={`https://www.youtube.com/embed/${youtubeId}?playsinline=1&controls=1&rel=0${randomStart && startOffsets[currentIndex] ? `&start=${startOffsets[currentIndex]}` : ''}`}
                                        title="YouTube audio player"
                                        frameBorder="0"
                                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                        allowFullScreen
                                        className="block w-full rounded-lg bg-black"
                                    />
                                    <div
                                        className="pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-lg bg-black"
                                        aria-hidden="true"
                                    />
                                    <div
                                        className="pointer-events-none absolute inset-x-0 top-24 h-16 bg-gradient-to-b from-black to-transparent"
                                        aria-hidden="true"
                                    />
                                    <div
                                        className="pointer-events-none absolute inset-x-0 bottom-0 h-20 rounded-b-lg bg-black"
                                        aria-hidden="true"
                                    />
                                    <div
                                        className="pointer-events-none absolute inset-x-0 bottom-20 h-12 bg-gradient-to-t from-black to-transparent"
                                        aria-hidden="true"
                                    />
                                    <div
                                        className="pointer-events-none absolute inset-y-0 left-0 w-14 rounded-l-lg bg-black"
                                        aria-hidden="true"
                                    />
                                    <div
                                        className="pointer-events-none absolute inset-y-0 left-14 w-10 bg-gradient-to-r from-black to-transparent"
                                        aria-hidden="true"
                                    />
                                    <div
                                        className="pointer-events-none absolute inset-y-0 right-0 w-14 rounded-r-lg bg-black"
                                        aria-hidden="true"
                                    />
                                    <div
                                        className="pointer-events-none absolute inset-y-0 right-14 w-10 bg-gradient-to-l from-black to-transparent"
                                        aria-hidden="true"
                                    />
                                </div>
                                <div className="flex flex-col gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 p-3">
                                    <div className="flex items-center gap-3">
                                        <label className="text-xs font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Volume</label>
                                        <input
                                            type="range"
                                            min="0"
                                            max="100"
                                            step="1"
                                            value={volume}
                                            onChange={(e) => handleVolumeChange(parseInt(e.target.value, 10))}
                                            className="flex-1 accent-indigo-600 dark:accent-indigo-400"
                                        />
                                        <span className="w-10 text-right text-xs text-gray-500 dark:text-gray-400">{volume}</span>
                                    </div>
                                    <div className="flex items-center gap-2 justify-center">
                                        <button
                                            type="button"
                                            onClick={togglePausePlayback}
                                            disabled={!playerRef.current}
                                            className="px-4 py-2 bg-indigo-600 dark:bg-indigo-500 hover:bg-indigo-700 dark:hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white text-sm font-semibold transition"
                                        >
                                            {playerPaused ? 'Resume' : 'Pause'}
                                        </button>
                                    </div>
                                </div>
                                <div className="text-xs text-center text-gray-500 dark:text-gray-400">
                                    Back to masking: this leaves a smaller center window tappable while covering much more of the YouTube frame.
                                </div>
                            </div>
                        ) : (
                            <div className="w-full max-w-[400px] space-y-3">
                                <div className="flex flex-col gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 p-3">
                                    <div className="flex items-center gap-3">
                                        <label className="text-xs font-semibold text-gray-600 dark:text-gray-300 whitespace-nowrap">Volume</label>
                                        <input
                                            type="range"
                                            min="0"
                                            max="100"
                                            step="1"
                                            value={volume}
                                            onChange={(e) => handleVolumeChange(parseInt(e.target.value, 10))}
                                            className="flex-1 accent-indigo-600 dark:accent-indigo-400"
                                        />
                                        <span className="w-10 text-right text-xs text-gray-500 dark:text-gray-400">{volume}</span>
                                    </div>
                                    <div className="flex items-center gap-2 justify-center">
                                        <button
                                            type="button"
                                            onClick={togglePausePlayback}
                                            disabled={!playerRef.current}
                                            className="px-4 py-2 bg-indigo-600 dark:bg-indigo-500 hover:bg-indigo-700 dark:hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white text-sm font-semibold transition"
                                        >
                                            {playerPaused ? 'Resume' : 'Pause'}
                                        </button>
                                    </div>
                                </div>
                                {audioStarted ? (
                                    <div className="w-full">
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
                                        onClick={() => {
                                            setAudioStarted(true);
                                            startAudioPlayback();
                                        }}
                                        className="w-[400px] h-[46px] bg-indigo-600 dark:bg-indigo-500 hover:bg-indigo-700 dark:hover:bg-indigo-600 rounded-lg flex items-center justify-center gap-2 text-white text-sm font-semibold transition"
                                    >
                                        &#9654; Tap to play audio
                                    </button>
                                )}
                            </div>
                        )}
                    </>
                ) : resolvingAudio ? (
                    <div className="w-[400px] h-[46px] bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
                        Looking up audio...
                    </div>
                ) : (
                    <div className="w-full max-w-[400px] space-y-3">
                        <div className="w-full min-h-[46px] px-4 py-3 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm text-center">
                            {audioResolveError || 'No audio available for this track.'}
                        </div>
                        <div className="flex flex-wrap justify-center gap-2">
                            <button
                                type="button"
                                onClick={retryAudioLookup}
                                className="px-4 py-2 bg-indigo-600 dark:bg-indigo-500 hover:bg-indigo-700 dark:hover:bg-indigo-600 rounded-lg text-white text-sm font-semibold transition"
                            >
                                Retry audio
                            </button>
                            <button
                                type="button"
                                onClick={handleSkipBrokenSong}
                                className="px-4 py-2 bg-gray-700 dark:bg-gray-600 hover:bg-gray-800 dark:hover:bg-gray-500 rounded-lg text-white text-sm font-semibold transition"
                            >
                                Skip broken song
                            </button>
                        </div>
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
