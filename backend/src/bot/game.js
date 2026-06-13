const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, StreamType } = require('@discordjs/voice');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder } = require('discord.js');
const { spawn } = require('child_process');
const fs = require('fs');
const ffmpegStatic = require('ffmpeg-static');
const { db } = require('../db/setup');
const { isCorrectGuess } = require('./utils');

// Map to track active games per guild
const activeGames = new Map();
const YT_PROXY = process.env.YT_PROXY || '';


function searchYoutube(title, artist) {
    const proxyArg = YT_PROXY ? ['--proxy', YT_PROXY] : [];
    const queries = [
        `${title} ${artist} official audio`,
        `${title} ${artist} official`,
        `${title} ${artist}`,
    ];
    for (const query of queries) {
        try {
            const result = require('child_process').spawnSync('yt-dlp', [
                ...proxyArg,
                '--flat-playlist', '--print', 'id',
                '--match-filter', 'duration<600',
                `ytsearch1:${query}`,
            ], { timeout: 15000, encoding: 'utf8' });
            if (result.status === 0 && result.stdout.trim().length === 11) {
                return result.stdout.trim();
            }
        } catch (e) { /* try next query */ }
    }
    return null;
}

function pickWeighted(items, n, weightFn) {
    if (items.length <= n) return items.slice();
    const result = [];
    const remaining = items.slice();
    for (let i = 0; i < n && remaining.length > 0; i++) {
        const total = remaining.reduce((s, it) => s + weightFn(it), 0);
        if (total === 0) break;
        let r = Math.random() * total;
        let idx = 0;
        while (idx < remaining.length - 1 && r > weightFn(remaining[idx])) {
            r -= weightFn(remaining[idx]);
            idx++;
        }
        result.push(remaining.splice(idx, 1)[0]);
    }
    return result;
}

async function getSongs(limit, genre, decades, equalDecades, popMin, popMax) {
    let where = ['hidden = 0'];
    let params = [];
    if (genre) { where.push('genre = ?'); params.push(genre); }
    if (popMin && popMin > 1) { where.push('popularity >= ?'); params.push(popMin); }
    if (popMax && popMax < 100) { where.push('popularity <= ?'); params.push(popMax); }

    // If no decades specified, default to all decades equally
    if (!decades || Object.keys(decades).length === 0) {
        decades = { 1950:1, 1960:1, 1970:1, 1980:1, 1990:1, 2000:1, 2010:1, 2020:1 };
    }

    if (!equalDecades) {
        const keys = Object.keys(decades);
        where.push(`decade IN (${keys.map(() => '?').join(',')})`);
        params.push(...keys.map(Number));
    }
    params.push(limit * 20);

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('getSongs timed out after 120s')), 120000);
        db.all(`SELECT id, title, artist, genre, decade, audio_url, youtube_id FROM songs WHERE ${where.join(' AND ')} ORDER BY RANDOM() LIMIT ?`, params, async (err, rows) => {
            clearTimeout(timer);
            if (err) return reject(err);
            if (!rows || rows.length === 0) return resolve([]);

            let pool = rows;
            if (decades && Object.keys(decades).length > 0 && !equalDecades) {
                pool = pickWeighted(rows, limit * 10, r => decades[r.decade] || 0);
            }

            let questions = [];
            for (let r of pool) {
                if (questions.length >= limit) break;

                let ytId = r.youtube_id || r.audio_url || null;
                if (!ytId) {
                    ytId = searchYoutube(r.title, r.artist);
                }
                if (!ytId) continue;

                if (!r.youtube_id) {
                    db.run('UPDATE songs SET youtube_id = ?, audio_url = ? WHERE id = ?', [ytId, ytId, r.id]);
                }

                questions.push({
                    id: r.id,
                    title: r.title,
                    artist: r.artist,
                    youtube_id: ytId,
                    genre: r.genre,
                    decade: r.decade
                });
            }
            resolve(questions);
        });
    });
}
async function startGame(interaction, options) {
    const guildId = interaction.guildId;
    if (activeGames.has(guildId)) {
        return interaction.editReply('A game is already running in this server!');
    }

    const { limit, duration, window: answerWindow, repeat, genre, decades, equalDecades, popMin, popMax } = options;
    const channel = interaction.member.voice.channel;

    console.log(`startGame: limit=${limit} genre=${genre} decades=${JSON.stringify(decades)} popMin=${popMin}`); // LOG

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);

    const gameState = {
        interaction, channel, voiceConnection: connection, player,
        questions: [], currentIdx: 0, scores: {}, guesses: {},
        duration, answerWindow, repeat, limit, collector: null
    };

    activeGames.set(guildId, gameState);

    await interaction.editReply('Fetching songs... Get ready!');

    console.log('Calling getSongs...'); // LOG
    try {
        const songs = await getSongs(limit, genre, decades, equalDecades, popMin, popMax);
        console.log(`getSongs returned ${songs.length} songs`); // LOG
        if (songs.length === 0) {
            console.log('No songs found'); // LOG
            await interaction.followUp('Could not find enough songs to start the game.');
            return stopGame(interaction, true);
        }
        gameState.questions = songs;
        console.log('Starting playNextQuestion'); // LOG
        await playNextQuestion(guildId);
    } catch (e) {
        console.error('startGame error:', e);
        await interaction.followUp('An error occurred while fetching songs.');
        stopGame(interaction, true);
    }
}

async function playNextQuestion(guildId) {
    const gameState = activeGames.get(guildId);
    if (!gameState) return;

    if (gameState.currentIdx >= gameState.limit || gameState.currentIdx >= gameState.questions.length) {
        return endGame(guildId);
    }

    const currentSong = gameState.questions[gameState.currentIdx];
    gameState.guesses = {}; // Reset guesses for this round

    try {
        const ytUrl = `https://www.youtube.com/watch?v=${currentSong.youtube_id}`;
        const cookiePath = "/data/cookies.txt";
        const extraArgs = [
            "--js-runtime", "node",
            "--remote-components", "ejs:github",
            "--extractor-args", "youtube:player_client=tv",
            "--extractor-args", "youtubepot-bgutilhttp:base_url=http://bgutil-pot:4416",
        ];
        const proxyArg = YT_PROXY ? ["--proxy", YT_PROXY] : [];
        const cookieArg = fs.existsSync(cookiePath) ? ["--cookies", cookiePath] : [];

        const ytdlp = spawn("yt-dlp", [
            ...proxyArg,
            ...cookieArg,
            ...extraArgs,
            "-f", "140",
            "-o", "-",
            ytUrl,
        ]);
        ytdlp.on("error", (e) => console.error("yt-dlp error:", e.message));
        const ffmpeg = spawn(ffmpegStatic, [
            "-stream_loop", String(gameState.repeat - 1),
            "-i", "pipe:0",
            "-c:a", "libopus",
            "-b:a", "128k",
            "-f", "ogg",
            "-application", "audio",
            "-loglevel", "quiet",
            "-err_detect", "ignore_err",
            "pipe:1",
        ]);
        ffmpeg.on("error", (e) => console.error("ffmpeg error:", e.message));
        ffmpeg.stderr.on("data", (d) => console.error("ffmpeg stderr:", d.toString().substring(0, 500)));

        ytdlp.stdout.on("error", () => {});
        ffmpeg.stdin.on("error", () => {});
        ffmpeg.stdout.on("error", () => {});
        ytdlp.stdout.pipe(ffmpeg.stdin);

        const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus, inlineVolume: true });

        const loadingMsg = await gameState.channel.send(`:musical_note: Loading question ${gameState.currentIdx + 1} of ${gameState.questions.length}...`);

        gameState.player.once(AudioPlayerStatus.Playing, async () => {
            const embed = new EmbedBuilder()
                .setTitle(`Question ${gameState.currentIdx + 1} of ${gameState.questions.length}`)
                .setDescription(`:musical_note: Playing ${gameState.repeat}x for **${gameState.duration}s** — **${gameState.answerWindow}s** to guess!`)
                .setColor('#0099ff');

            const guessButton = new ButtonBuilder()
                .setCustomId('guess_button')
                .setLabel('Make a Guess')
                .setStyle(ButtonStyle.Primary);

            const row = new ActionRowBuilder().addComponents(guessButton);

            await loadingMsg.edit({ embeds: [embed], components: [row] });

            const totalRound = (gameState.duration * gameState.repeat + gameState.answerWindow) * 1000;
            const filter = i => i.customId === 'guess_button';
            gameState.collector = loadingMsg.createMessageComponentCollector({ filter, time: totalRound });

            gameState.collector.on('collect', async i => {
                const modal = new ModalBuilder()
                    .setCustomId('guess_modal')
                    .setTitle('Make Your Guess');

                const titleInput = new TextInputBuilder()
                    .setCustomId('guess_title')
                    .setLabel("Song Title")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false);

                const artistInput = new TextInputBuilder()
                    .setCustomId('guess_artist')
                    .setLabel("Artist Name")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false);

                const firstActionRow = new ActionRowBuilder().addComponents(titleInput);
                const secondActionRow = new ActionRowBuilder().addComponents(artistInput);

                modal.addComponents(firstActionRow, secondActionRow);
                await i.showModal(modal);
            });

            const playStart = Date.now();
            console.log(`Playing started for Q${gameState.currentIdx+1}, clip=${gameState.duration}s`); // LOG
            const clipTime = gameState.duration * gameState.repeat * 1000;
            setTimeout(() => {
                console.log(`Clip stop fired after ${(Date.now()-playStart)/1000}s`); // LOG
                gameState.player.stop();
            }, clipTime);
            setTimeout(async () => {
                try {
                    if (gameState.collector) gameState.collector.stop();
                    gameState.player.stop();
                    console.log(`Grade fired after ${(Date.now()-playStart)/1000}s`); // LOG
                    await gradeAndShowResults(guildId, loadingMsg, currentSong);
                } catch (e) {
                    console.error('Grade timeout error:', e);
                }
            }, (clipTime + gameState.answerWindow * 1000));
        });

        gameState.player.play(resource);



        // Safety timeout: if audio doesn't start within 45s, skip this song
        const playingTimeout = setTimeout(() => {
            console.error('Playing event timed out for song', currentSong.youtube_id);
            if (gameState.player.state.status !== AudioPlayerStatus.Playing) {
                gameState.player.stop();
                const failedSong = gameState.questions[gameState.currentIdx];
                if (failedSong) db.run('UPDATE songs SET hidden = 1 WHERE id = ?', [failedSong.id]);
                gameState.channel.send(`Song ${gameState.currentIdx + 1} failed to load. Skipping...`);
                gameState.currentIdx++;
                setTimeout(() => playNextQuestion(guildId), 2000);
            }
        }, 45000);

        // Clear the safety timeout once Playing fires
        gameState.player.once(AudioPlayerStatus.Playing, () => clearTimeout(playingTimeout));
    } catch (e) {
        console.error('Failed to play stream', e);
        const failedSong = gameState.questions[gameState.currentIdx];
        if (failedSong) {
            db.run('UPDATE songs SET hidden = 1 WHERE id = ?', [failedSong.id]);
        }
        gameState.channel.send(`Error playing song ${gameState.currentIdx + 1}. Skipping...`);
        gameState.currentIdx++;
        setTimeout(() => playNextQuestion(guildId), 2000);
    }
}

async function gradeAndShowResults(guildId, message, currentSong) {
    const gameState = activeGames.get(guildId);
    if (!gameState) return;

    // Remove buttons from message
    try {
        await message.edit({ components: [] });
    } catch (e) { /* ignore */ }

    let resultsText = `**The song was:** ${currentSong.title} by ${currentSong.artist}\n\n`;

    if (Object.keys(gameState.guesses).length === 0) {
        resultsText += "No one made a guess!";
    } else {
        for (const [userId, guess] of Object.entries(gameState.guesses)) {
            const isTitleCorrect = isCorrectGuess(guess.title, currentSong.title);
            const isArtistCorrect = isCorrectGuess(guess.artist, currentSong.artist);

            let points = 0;
            if (isTitleCorrect) points += 1;
            if (isArtistCorrect) points += 1;

            if (!gameState.scores[userId]) gameState.scores[userId] = 0;
            gameState.scores[userId] += points;

            const user = await gameState.interaction.client.users.fetch(userId);
            resultsText += `${user.username}: ${points} points (Title: ${isTitleCorrect ? '✅' : '❌'}, Artist: ${isArtistCorrect ? '✅' : '❌'})\n`;
        }
    }

    const embed = new EmbedBuilder()
        .setTitle(`Results for Question ${gameState.currentIdx + 1}`)
        .setDescription(resultsText)
        .setColor('#00ff00');

    await gameState.channel.send({ embeds: [embed] });

    gameState.currentIdx++;
    setTimeout(() => playNextQuestion(guildId), 5000); // 5 second pause between questions
}

async function endGame(guildId) {
    const gameState = activeGames.get(guildId);
    if (!gameState) return;

    if (gameState.voiceConnection) {
        gameState.voiceConnection.destroy();
    }

    let finalScores = "**Final Scores:**\n";
    if (Object.keys(gameState.scores).length === 0) {
        finalScores += "No points scored!";
    } else {
        const sortedScores = Object.entries(gameState.scores).sort(([, a], [, b]) => b - a);
        for (const [userId, score] of sortedScores) {
            const user = await gameState.interaction.client.users.fetch(userId);
            finalScores += `${user.username}: ${score} points\n`;
        }
    }

    const embed = new EmbedBuilder()
        .setTitle('Trivia Game Over!')
        .setDescription(finalScores)
        .setColor('#ffcc00');

    await gameState.channel.send({ embeds: [embed] });
    activeGames.delete(guildId);
}

async function stopGame(interaction, quiet = false) {
    const guildId = interaction.guildId;
    const gameState = activeGames.get(guildId);

    if (!gameState) {
        if (!quiet && interaction.replied === false) {
            return interaction.reply({ content: 'No game is currently running.', ephemeral: true });
        }
        return;
    }

    if (gameState.collector) gameState.collector.stop();
    if (gameState.voiceConnection) gameState.voiceConnection.destroy();

    activeGames.delete(guildId);

    if (!quiet) {
        if (!interaction.replied) await interaction.reply('The game has been stopped.');
        else await interaction.followUp('The game has been stopped.');
    }
}

// Hook to handle modal submissions globally
function handleModalSubmit(interaction) {
    if (!interaction.isModalSubmit() || interaction.customId !== 'guess_modal') return;

    const guildId = interaction.guildId;
    const gameState = activeGames.get(guildId);

    if (!gameState) {
        return interaction.reply({ content: 'No active game found.', ephemeral: true });
    }

    const titleGuess = interaction.fields.getTextInputValue('guess_title') || '';
    const artistGuess = interaction.fields.getTextInputValue('guess_artist') || '';

    gameState.guesses[interaction.user.id] = { title: titleGuess, artist: artistGuess };

    interaction.reply({ content: `Your guess has been recorded! (Title: "${titleGuess}", Artist: "${artistGuess}")`, ephemeral: true });
}

module.exports = {
    startGame,
    stopGame,
    handleModalSubmit
};
