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

    // Clear old global commands (they cache for hours)
    try {
        const globalCommands = await rest.get(Routes.applicationCommands(client.user.id));
        for (const cmd of globalCommands) {
            await rest.delete(Routes.applicationCommand(client.user.id, cmd.id));
        }
        if (globalCommands.length > 0) console.log(`Cleared ${globalCommands.length} stale global commands`);
    } catch (e) { /* ignore */ }

    // Register guild commands (instant)
    if (!guildId) {
        console.log('No GUILD_ID set — commands registered globally (may take 1h to update)');
    }
    const route = guildId
        ? Routes.applicationGuildCommands(client.user.id, guildId)
        : Routes.applicationCommands(client.user.id);
    try {
        console.log(`Started refreshing ${commandsToRegister.length} application (/) commands.`);
        const data = await rest.put(route, { body: commandsToRegister });
        console.log(`Successfully reloaded ${data.length} application (/) commands.`);
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

const { handleModalSubmit } = require('./game');

client.on('interactionCreate', async interaction => {
    if (interaction.isModalSubmit()) {
        return handleModalSubmit(interaction);
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
