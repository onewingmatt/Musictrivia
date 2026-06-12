const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder } = require('discord.js');
const { spawn } = require('child_process');
const fs = require('fs');
const ffmpegStatic = require('ffmpeg-static');
const { db } = require('../db/setup');
const { isCorrectGuess, resolveYoutubeIdAsync } = require('./utils');

// Map to track active games per guild
const activeGames = new Map();

async function getSongs(limit) {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM songs ORDER BY RANDOM() LIMIT ?`, [limit * 2], async (err, rows) => {
            if (err) return reject(err);
            if (!rows || rows.length === 0) return resolve([]);

            let questions = [];
            for (let r of rows) {
                let ytId = r.youtube_id || (r.audio_url && r.audio_url.length === 11 ? r.audio_url : null);
                if (!ytId) continue;
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

    const { limit, duration } = options;
    const channel = interaction.member.voice.channel;

    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);

    const gameState = {
        interaction,
        channel: interaction.channel,
        voiceConnection: connection,
        player,
        questions: [],
        currentIdx: 0,
        scores: {}, // userId -> score
        guesses: {}, // userId -> { title, artist } for current question
        duration,
        limit,
        collector: null
    };

    activeGames.set(guildId, gameState);

    await interaction.editReply('Fetching songs... Get ready!');

    try {
        const songs = await getSongs(limit);
        if (songs.length === 0) {
            await interaction.followUp('Could not find enough songs to start the game.');
            return stopGame(interaction, true);
        }
        gameState.questions = songs;
        await playNextQuestion(guildId);
    } catch (e) {
        console.error(e);
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
        const cookieArg = fs.existsSync(cookiePath) ? ["--cookies", cookiePath] : [];

        const ytdlp = spawn("yt-dlp", [
            ...cookieArg,
            ...extraArgs,
            "-f", "140",
            "-g", ytUrl,
        ]);

        let audioUrl = "";
        ytdlp.stdout.on("data", (data) => {
            audioUrl += data.toString();
        });
        let ytdlpStderr = "";
        ytdlp.stderr.on("data", (data) => {
            ytdlpStderr += data.toString();
        });

        await new Promise((resolve, reject) => {
            ytdlp.on("close", (code) => {
                if ((code === 0 || code === null) && audioUrl.trim()) resolve();
                else {
                    console.error("yt-dlp exit code:", code, "for", currentSong.youtube_id || currentSong.audio_url);
                    console.error("yt-dlp stderr:", (ytdlpStderr || "(empty)").substring(0, 2000));
                    reject(new Error("yt-dlp exited with code " + code));
                }
            });
            ytdlp.on("error", (e) => {
                console.error("yt-dlp spawn error:", e.message);
                reject(e);
            });
        });
        const ffmpeg = spawn(ffmpegStatic, [
            "-i", audioUrl.trim(),
            "-f", "s16le",
            "-ar", "48000",
            "-ac", "2",
            "-loglevel", "quiet",
            "pipe:1",
        ]);
        ffmpeg.on("error", (e) => console.error("ffmpeg error:", e));

        const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true });
        gameState.player.play(resource);

        const embed = new EmbedBuilder()
            .setTitle(`Question ${gameState.currentIdx + 1} of ${gameState.questions.length}`)
            .setDescription(`Playing audio for **${gameState.duration} seconds**! Make your guess.`)
            .setColor('#0099ff');

        const guessButton = new ButtonBuilder()
            .setCustomId('guess_button')
            .setLabel('Make a Guess')
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(guessButton);

        const message = await gameState.channel.send({ embeds: [embed], components: [row] });

        // Set up collector for the button
        const filter = i => i.customId === 'guess_button';
        gameState.collector = message.createMessageComponentCollector({ filter, time: gameState.duration * 1000 });

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

        // Setup a timer to stop the audio and grade
        setTimeout(async () => {
            if (gameState.player.state.status === AudioPlayerStatus.Playing) {
                gameState.player.stop();
            }
            if (gameState.collector) {
                gameState.collector.stop();
            }
            await gradeAndShowResults(guildId, message, currentSong);
        }, gameState.duration * 1000);

    } catch (e) {
        console.error('Failed to play stream', e);
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
