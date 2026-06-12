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

            const member = interaction.member;
            if (!member.voice.channel) {
                return interaction.reply({ content: 'You must be in a voice channel to start the game!', ephemeral: true });
            }

            await interaction.deferReply();
            try {
                await startGame(interaction, { limit, duration, window });
            } catch (error) {
                console.error(error);
                await interaction.editReply({ content: 'Failed to start the game. An error occurred.' });
            }
        } else if (subcommand === 'stop') {
            await stopGame(interaction);
        }
    },
};
