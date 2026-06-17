const { Client, GatewayIntentBits, Partials, Collection, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');

// Load commands (we will write trivia.js next)
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
const commandsToRegister = [];

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        commandsToRegister.push(command.data.toJSON());
    } else {
        console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
}

client.once('ready', async () => {
    console.log(`Discord bot logged in as ${client.user.tag}`);

    // Log available guilds for GUILD_ID discovery
    const guilds = client.guilds.cache.map(g => `${g.name} (${g.id})`);
    if (guilds.length > 0) console.log('Guilds:', guilds.join(', '));
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const guildId = process.env.GUILD_ID;

    // If GUILD_ID is set, register guild-scoped only (instant, no duplicates).
    // Otherwise register globally (slow cache, ~1h propagation).
    if (guildId) {
        try {
            console.log(`Registering for guild ${guildId} (instant, guild-scoped)...`);
            const data = await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commandsToRegister });
            console.log(`Guild commands updated for ${guildId} (${data.length} commands)`);
        } catch (error) {
            console.error('Error registering guild commands:', error);
        }
    } else {
        try {
            console.log(`Registering ${commandsToRegister.length} global application (/) commands...`);
            const data = await rest.put(Routes.applicationCommands(client.user.id), { body: commandsToRegister });
            console.log(`Global commands updated (${data.length} commands)`);
        } catch (error) {
            console.error('Error registering global commands:', error);
        }
        console.log('No GUILD_ID set — global only (may take 1h to update in new servers)');
    }
});

const { handleModalSubmit } = require('./game');
const { db } = require('../db/setup');

client.on('interactionCreate', async interaction => {
    if (interaction.isModalSubmit()) {
        return handleModalSubmit(interaction);
    }

    // Handle Report Song button globally (no collector timeout)
    if (interaction.isButton() && interaction.customId && interaction.customId.startsWith('report_')) {
        await interaction.deferReply({ flags: 64 });
        const songId = parseInt(interaction.customId.replace('report_', ''));
        db.run('UPDATE songs SET hidden = 1 WHERE id = ?', [songId], (err) => {
            if (err) console.error('Failed to hide reported song:', err.message);
        });
        await interaction.editReply({ content: 'Song reported. It won\'t appear in future games.', flags: 64 });
        console.log('Song reported via button, id=' + songId + ' by ' + interaction.user.tag);
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);

    if (!command) {
        console.error(`No command matching ${interaction.commandName} was found.`);
        return;
    }

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
        } else {
            await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
        }
    }
});

function startBot() {
    if (!process.env.DISCORD_TOKEN) {
        console.log('No DISCORD_TOKEN provided. Skipping Discord bot initialization.');
        return;
    }
    client.login(process.env.DISCORD_TOKEN).catch(console.error);
}

module.exports = { client, startBot };
