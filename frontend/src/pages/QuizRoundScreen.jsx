import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';

// If playback hasn't started this long after tapping play, or the playhead
// freezes this long mid-clip while supposedly playing, treat the song's audio
// as broken and swap in a replacement for the same question slot.
const INITIAL_BUFFER_MS = 20000;
const MID_PLAY_STALL_MS = 8000;

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
    const [buffering, setBuffering] = useState(false);
    const [audioNonce, setAudioNonce] = useState(0);
    const audioRef = useRef(null);
    const resolvedYtIdsRef = useRef(new Set());
    const resolvingYtIdsRef = useRef(new Set());
    const stallMonitorRef = useRef(null);
    const lastPlayheadRef = useRef(0);
    const lastPlayheadAtRef = useRef(0);
    const playbackStartedAtRef = useRef(0);
    const failedSongRef = useRef(null);
    const feedbackRef = useRef(null);
    const activeSrcRef = useRef(null);

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

    // Override the media session so Android Auto / lock screen shows "Music Quiz",
    // not the real song metadata (the whole reason we proxy audio instead of iframe).
    useEffect(() => {
        if ('mediaSession' in navigator) {
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: 'Music Quiz',
                    artist: 'Music Trivia',
                });
            } catch {}
        }
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
            rememberPlayedSongs();
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

        rememberPlayedSongs();
        sessionStorage.setItem('quizResults', JSON.stringify(nextResults));
        navigate('/results');
    };

    const retryAudioLookup = () => {
        if (!currentQ) return;
        if (currentQ.audio_url) {
            // Stream load failed — force the audio element to re-request
            setAudioNonce(prev => prev + 1);
            setAudioResolveError('');
            setAudioStarted(false);
            return;
        }
        resolvingYtIdsRef.current.delete(currentQ.id);
        resolvedYtIdsRef.current.delete(currentQ.id);
        setAudioResolveError('');
        setResolvingAudio(false);
        setAudioLookupNonce(prev => prev + 1);
    };

    const clearStallMonitor = () => {
        if (stallMonitorRef.current) {
            clearInterval(stallMonitorRef.current);
            stallMonitorRef.current = null;
        }
    };

    // Flag the current song as broken (best effort) and swap in a replacement
    // for the same question slot using the round's original filters. Falls
    // back to skipping the question only if no replacement can be found.
    const failCurrentSong = async (reason) => {
        if (!currentQ || feedbackRef.current) return;
        if (failedSongRef.current === currentQ.id) return;
        failedSongRef.current = currentQ.id;

        clearStallMonitor();

        // Best-effort server-side flag; never block replacing on it.
        api.post('/quiz/flag-song', { song_id: currentQ.id, reason }).catch(() => { /* best effort */ });

        try {
            // Re-run the round's filters, excluding every song already in the
            // round (including the one that just failed) so we get a fresh pick.
            const filters = JSON.parse(sessionStorage.getItem('quizFilters') || '{}');
            const excludeIds = [...new Set(questions.map(q => q.id))];
            const res = await api.post('/quiz/generate', {
                ...filters,
                exclude_song_ids: excludeIds,
                limit: 1,
            });

            const replacement = res.data.questions && res.data.questions[0];
            if (replacement) {
                // Same slot, new song — the question is not burned.
                setQuestions(prev => prev.map((q, i) => i === currentIndex ? replacement : q));
                failedSongRef.current = null;
                setAudioStarted(false);
                setProgress(0);
                setAudioResolveError('');
                setPlayerPaused(false);
                setBuffering(false);
                const audio = audioRef.current;
                if (audio) {
                    audio.pause();
                    try { audio.removeAttribute('src'); audio.load(); } catch {}
                }
                activeSrcRef.current = null;
                return;
            }

            // No replacement available (filters too narrow) — fall back to
            // recording a skipped answer and advancing.
            const ans = await api.post('/quiz/answer', {
                song_id: currentQ.id,
                guessed_title: '',
                guessed_artist: '',
                fuzzy_threshold: fuzzyThreshold
            });
            const nextResults = [...results, {
                question: currentQ,
                result: { ...ans.data, skipped_audio: true },
            }];
            setResults(nextResults);
            advanceToNextQuestion(nextResults);
        } catch (err) {
            console.error('Error replacing stalled song', err);
            // Even on failure, don't strand the round on a dead question.
            try {
                advanceToNextQuestion(results);
            } catch { /* already at the end */ }
        }
    };

    // Watchdog: fails the song if it never starts playing within
    // INITIAL_BUFFER_MS, or if the playhead freezes for MID_PLAY_STALL_MS
    // while supposedly playing (mid-clip re-buffering).
    const startStallMonitor = () => {
        clearStallMonitor();
        playbackStartedAtRef.current = 0;
        lastPlayheadRef.current = 0;
        lastPlayheadAtRef.current = 0;

        stallMonitorRef.current = setInterval(() => {
            const audio = audioRef.current;
            if (!audio) return;
            const nowMs = Date.now();

            try {
                if (playbackStartedAtRef.current === 0) {
                    playbackStartedAtRef.current = nowMs;
                    lastPlayheadAtRef.current = 0;
                    lastPlayheadAtRef.current = nowMs;
                }
                if (audio.paused) {
                    // Intentional pause (user or clip end) — reset the clock so
                    // resuming gets a fresh stall window.
                    lastPlayheadAtRef.current = nowMs;
                    return;
                }

                const t = audio.currentTime || 0;
                const started = audio.readyState >= 3; // HAVE_FUTURE_DATA

                if (!started) {
                    // Still waiting for the first data. Only the initial-buffer
                    // timeout applies here — a slow stream is not a mid-play
                    // stall, so don't let the playhead-freeze check fire early.
                    if (nowMs - playbackStartedAtRef.current > INITIAL_BUFFER_MS) {
                        failCurrentSong('stall');
                    }
                    return;
                }

                if (t !== lastPlayheadRef.current) {
                    lastPlayheadRef.current = t;
                    lastPlayheadAtRef.current = nowMs;
                } else if (nowMs - lastPlayheadAtRef.current > MID_PLAY_STALL_MS) {
                    failCurrentSong('stall');
                }
            } catch { /* audio getters can throw while the element tears down */ }
        }, 1000);
    };

    const handleSkipBrokenSong = () => {
        if (!currentQ) return;
        failCurrentSong('manual_skip');
    };

    const handleReportAndSkip = async () => {
        if (!currentQ) return;
        if (!window.confirm('Report this song as broken? It will be skipped and the admin can review the report.')) return;

        try {
            await api.post('/quiz/report', {
                song_id: currentQ.id,
                reason: 'audio_failed',
                note: 'Reported by player',
            });
        } catch (err) {
            console.error('Failed to record song report', err);
        }

        await handleSkipBrokenSong();
    };

    const handleVolumeChange = (nextVolume) => {
        setVolume(nextVolume);
        localStorage.setItem('quizVolume', String(nextVolume));
        if (audioRef.current) {
            try { audioRef.current.volume = nextVolume / 100; } catch {}
        }
    };

    const togglePausePlayback = () => {
        const audio = audioRef.current;
        if (!audio) return;

        try {
            if (playerPaused) {
                audio.play().catch(() => {});
                setPlayerPaused(false);
            } else {
                audio.pause();
                setPlayerPaused(true);
            }
        } catch (err) {
            console.error('Failed to toggle playback', err);
        }
    };

    const currentQ = questions.length > 0 ? questions[currentIndex] : null;
    const youtubeId = currentQ?.audio_url;
    const hasYoutube = youtubeId && youtubeId.length === 11;
    const streamStart = randomStart && startOffsets[currentIndex] ? startOffsets[currentIndex] : 0;
    const streamSrc = `/api/quiz/audio-stream/${youtubeId || ''}${streamStart ? `?start=${streamStart}` : ''}${audioNonce ? `${streamStart ? '&' : '?'}n=${audioNonce}` : ''}`;

    const startAudioPlayback = () => {
        if (!hasYoutube || !currentQ) return;
        const audio = audioRef.current;
        if (!audio) return;

        audio.volume = volume / 100;
        activeSrcRef.current = streamSrc;
        startStallMonitor();
        audio.play().catch(err => {
            console.error('Failed to play audio', err);
            setAudioResolveError('Playback failed. Tap to play audio again.');
        });
    };

    // Seek to the random start offset once metadata is available
    const handleLoadedMetadata = () => {
        const audio = audioRef.current;
        if (!audio) return;
        const startSec = randomStart && startOffsets[currentIndex] ? startOffsets[currentIndex] : 0;
        if (startSec > 0 && startSec < audio.duration) {
            try { audio.currentTime = startSec; } catch {}
        }
    };

    // Progress + clip-end enforcement via the native timeupdate event
    const handleTimeUpdate = () => {
        const audio = audioRef.current;
        if (!audio) return;
        const startSec = randomStart && startOffsets[currentIndex] ? startOffsets[currentIndex] : 0;
        const elapsed = audio.currentTime - startSec;
        const p = Math.min(100, Math.max(0, (elapsed / clipDuration) * 100));
        setProgress(p);

        if (elapsed >= clipDuration) {
            if (loopClip) {
                audio.currentTime = startSec;
                audio.play().catch(() => {});
            } else {
                audio.pause();
                setProgress(100);
                setPlayerPaused(true);
                setBuffering(false);
            }
        }
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

    // Cleanup old audio element when the question changes.
    useEffect(() => {
        setAudioStarted(false);
        setProgress(0);
        setBuffering(false);
        clearStallMonitor();
        failedSongRef.current = null;
        activeSrcRef.current = null;
        const audio = audioRef.current;
        if (audio) {
            audio.pause();
            try { audio.removeAttribute('src'); audio.load(); } catch {}
        }
    }, [currentIndex]);

    // Stop watching the audio once the question has been answered.
    useEffect(() => {
        feedbackRef.current = feedback;
        if (feedback) clearStallMonitor();
    }, [feedback]);

    // Save played song IDs to localStorage to avoid repeats in future rounds
    const rememberPlayedSongs = (qs = questions) => {
        if (!qs.length) return;
        const playedIds = qs.map(q => q.id);
        const existing = JSON.parse(localStorage.getItem('excludeSongIds') || '[]');
        const merged = [...new Set([...existing, ...playedIds])];
        // Keep last 200 to avoid unbounded growth
        localStorage.setItem('excludeSongIds', JSON.stringify(merged.slice(-200)));
    };

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
                        <audio
                            ref={audioRef}
                            src={streamSrc}
                            preload="auto"
                            playsInline
                            onLoadedMetadata={handleLoadedMetadata}
                            onTimeUpdate={handleTimeUpdate}
                            onWaiting={() => setBuffering(true)}
                            onPlaying={() => setBuffering(false)}
                            onEnded={() => { setProgress(100); setPlayerPaused(true); setBuffering(false); }}
                            onError={() => {
                                // Ignore errors from a stream we've already torn down.
                                if (activeSrcRef.current !== streamSrc) return;
                                clearStallMonitor();
                                failCurrentSong('player_error');
                            }}
                        />
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
                                        disabled={!audioStarted}
                                        className="px-4 py-2 bg-indigo-600 dark:bg-indigo-500 hover:bg-indigo-700 dark:hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white text-sm font-semibold transition"
                                    >
                                        {playerPaused ? 'Resume' : 'Pause'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleReportAndSkip}
                                        disabled={!audioStarted}
                                        className="px-4 py-2 bg-rose-600 hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white text-sm font-semibold transition"
                                    >
                                        Report
                                    </button>
                                </div>
                            </div>
                            {audioStarted ? (
                                <div className="w-full">
                                    <div className="w-full h-[46px] bg-gray-900 dark:bg-gray-800 rounded-t-lg flex items-center justify-center gap-2">
                                        <span className="text-white text-sm">
                                            {buffering ? 'Buffering...' : progress >= 100 && !loopClip ? '\u23F8 Audio Finished' : '\u25B6 Playing clip...'}
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
                            <button
                                type="button"
                                onClick={handleReportAndSkip}
                                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-600 rounded-lg text-white text-sm font-semibold transition"
                            >
                                Report &amp; skip
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
