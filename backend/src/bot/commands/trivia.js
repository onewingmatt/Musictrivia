const { SlashCommandBuilder } = require('discord.js');
const { startGame, stopGame } = require('../game');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('trivia')
        .setDescription('Play a music trivia game')
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('Start a music trivia game in your voice channel')
                .addIntegerOption(option =>
                    option.setName('limit')
                        .setDescription('Number of questions (default: 5)')
                        .setMinValue(1)
                        .setMaxValue(50))
                .addIntegerOption(option =>
                    option.setName('duration')
                        .setDescription('Duration to play each song in seconds (default: 20)')
                        .setMinValue(5)
                        .setMaxValue(60))
                .addIntegerOption(option =>
                    option.setName('answer')
                        .setDescription('Seconds after clip to submit guesses (default: 20)')
                        .setMinValue(5)
                        .setMaxValue(60))
                .addIntegerOption(option =>
                    option.setName('repeat')
                        .setDescription('How many times to play the clip (default: 1)')
                        .setMinValue(1)
                        .setMaxValue(3))
                .addStringOption(option =>
                    option.setName('genre')
                        .setDescription('Genre filter (e.g. Rock, Hip Hop, Jazz)')
                        .setMaxLength(50))
                .addStringOption(option =>
                    option.setName('decades')
                        .setDescription('Decade weights like 1980:3 1990:5 2000:2')
                        .setMaxLength(100))
                .addBooleanOption(option =>
                    option.setName('equal_decades')
                        .setDescription('Ignore weights, pick from all decades equally'))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('stop')
                .setDescription('Stop the current music trivia game')
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'start') {
            const limit = interaction.options.getInteger('limit') || 5;
            const duration = interaction.options.getInteger('duration') || 20;
            const window = interaction.options.getInteger('answer') || 20;
            const repeat = interaction.options.getInteger('repeat') || 1;
            const genre = interaction.options.getString('genre') || '';
            const decadesRaw = interaction.options.getString('decades') || '';
            const equalDecades = interaction.options.getBoolean('equal_decades') || false;

            // Parse decades string "1980:3 1990:5 2000:2" into weights
            let decades = {};
            if (decadesRaw) {
                for (const part of decadesRaw.split(/[,\s]+/)) {
                    const m = part.match(/^(\d{4})(?::(\d+))?$/);
                    if (m) decades[m[1]] = parseInt(m[2] || '1');
                }
            }

            const member = interaction.member;
            if (!member.voice.channel) {
                return interaction.reply({ content: 'You must be in a voice channel to start the game!', ephemeral: true });
            }

            await interaction.deferReply();
            try {
                await startGame(interaction, { limit, duration, window, repeat, genre, decades, equalDecades });
            } catch (error) {
                console.error(error);
                await interaction.editReply({ content: 'Failed to start the game. An error occurred.' });
            }
        } else if (subcommand === 'stop') {
            await stopGame(interaction);
        }
    },
};
