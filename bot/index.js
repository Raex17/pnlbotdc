'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Client, GatewayIntentBits, REST, Routes, Events, MessageFlags } = require('discord.js');

const pnlCommand = require('./commands/pnl');
const setbgCommand = require('./commands/setbg');
const trendingCommand = require('./commands/trending');
const convertCommand = require('./commands/convert');
const cookCommand = require('./commands/cook');

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId || !guildId) {
    console.error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
    process.exit(1);
  }

  const commands = [
    pnlCommand.data.toJSON(),
    ...setbgCommand.data.map((d) => d.toJSON()),
    trendingCommand.data.toJSON(),
    cookCommand.data.toJSON(),
  ];

  const rest = new REST().setToken(token);
  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Registered ${commands.length} commands to guild ${guildId}`);
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, () => {
  console.log(`Ready - logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.content.toLowerCase().startsWith('.cv ')) {
    await convertCommand.handleMessage(message).catch(console.error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      if (name === 'pnl') {
        await pnlCommand.execute(interaction);
      } else if (name === 'setbgp' || name === 'setbgl') {
        await setbgCommand.execute(interaction);
      } else if (name === 'trending') {
        await trendingCommand.execute(interaction);
      } else if (name === 'cook') {
        await cookCommand.execute(interaction);
      }
    } else if (interaction.isStringSelectMenu() || interaction.isButton()) {
      const customId = interaction.customId || '';
      if (customId.startsWith('pnl_')) {
        await pnlCommand.handleInteraction(interaction);
      } else if (customId.startsWith('cook_refresh_')) {
        await cookCommand.handleRefresh(interaction);
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const reply = { content: `Error: ${err.message}`, flags: MessageFlags.Ephemeral };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch {}
  }
});

(async () => {
  await registerCommands();
  await client.login(process.env.DISCORD_TOKEN);
})();
