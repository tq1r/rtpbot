const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const RTPCollector = require('./collector');
const GridAnalyzer = require('./analyzer');
const HeatmapGenerator = require('./heatmap');
const GoldZoneFinder = require('./gold-finder');

// ============================================================
// LOAD CONFIG
// ============================================================
const configPath = path.resolve(__dirname, '..', 'config.json');

// Create default config if missing
if (!fs.existsSync(configPath)) {
  const defaultConfig = {
    discord: { clientId: null },
    server: { host: 'donutsmp.net', port: 25565, version: '1.21.4' },
    auth: { email: '', password: '' },
    rtp: { command: '/rtp', sampleCount: 1000, delayMs: 2000, parseFromChat: true },
    worldBorder: 225000,
    goldZone: { cellSize: 5000, thresholdPercentile: 10, smoothing: true },
    tpahere: { target: '.ttxmoo', enabled: true, mode: 'tpahere' }
  };
  fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
  console.log('Created default config.json');
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Token comes from environment variable (set in .env file or StackBlitz secrets)
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('No DISCORD_TOKEN found! Create a .env file with: DISCORD_TOKEN=your_token_here');
  process.exit(1);
}

const dataDir = path.resolve(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ============================================================
// GLOBAL STATE
// ============================================================
let currentOperation = null;
let collector = null;
let goldFinder = null;
let progressMessage = null;
let analysisResults = null;

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// ============================================================
// SLASH COMMANDS
// ============================================================
const commands = [
  new SlashCommandBuilder()
    .setName('collect')
    .setDescription('Start collecting RTP coordinates')
    .addIntegerOption(o => o.setName('count').setDescription('Number of RTPs').setMinValue(10).setMaxValue(10000))
    .addIntegerOption(o => o.setName('delay').setDescription('Delay between RTPs in ms').setMinValue(500).setMaxValue(30000)),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop the current operation'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check current status and config'),

  new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('Analyze collected data and find gold zones'),

  new SlashCommandBuilder()
    .setName('heatmap')
    .setDescription('Generate and send the heatmap image'),

  new SlashCommandBuilder()
    .setName('goldfind')
    .setDescription('RTP until gold zone, then TPA you there')
    .addStringOption(o => o.setName('target').setDescription('Player name (default from config)')),

  new SlashCommandBuilder()
    .setName('settarget')
    .setDescription('Change the TPA target player')
    .addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setaccount')
    .setDescription('Set your Minecraft Microsoft account (ephemeral - only you see this)')
    .addStringOption(o => o.setName('email').setDescription('Microsoft email').setRequired(true))
    .addStringOption(o => o.setName('password').setDescription('Microsoft password').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setmode')
    .setDescription('Set TPA mode: tpahere (summon player to bot) or tpa (bot goes to player)')
    .addStringOption(o => o.setName('mode')
      .setDescription('tpahere = summon player here, tpa = bot goes to player')
      .setRequired(true)
      .addChoices(
        { name: 'tpahere (summon player to bot)', value: 'tpahere' },
        { name: 'tpa (bot goes to player)', value: 'tpa' }
      )),

  new SlashCommandBuilder()
    .setName('resetdata')
    .setDescription('Delete all collected data and start fresh'),

  new SlashCommandBuilder()
    .setName('topclusters')
    .setDescription('Show the top 5 largest unexplored areas (best places to search)'),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
  try {
    console.log('Registering slash commands...');
    const appInfo = await rest.get(Routes.currentApplication());
    config.discord.clientId = config.discord.clientId || appInfo.id;
    saveConfig();
    await rest.put(Routes.applicationCommands(config.discord.clientId), { body: commands.map(c => c.toJSON()) });
    console.log('Commands registered!');
  } catch (err) {
    console.error('Failed to register commands:', err.message);
  }
}

// ============================================================
// DISCORD BOT
// ============================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  try {
    switch (commandName) {
      case 'collect':   await handleCollect(interaction); break;
      case 'stop':      await handleStop(interaction); break;
      case 'status':    await handleStatus(interaction); break;
      case 'analyze':   await handleAnalyze(interaction); break;
      case 'heatmap':   await handleHeatmap(interaction); break;
      case 'goldfind':  await handleGoldFind(interaction); break;
      case 'settarget': await handleSetTarget(interaction); break;
      case 'setaccount':await handleSetAccount(interaction); break;
      case 'setmode':   await handleSetMode(interaction); break;
      case 'resetdata': await handleResetData(interaction); break;
      case 'topclusters': await handleTopClusters(interaction); break;
    }
  } catch (err) {
    const reply = { content: `Error: ${err.message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
});

// ============================================================
// COMMAND HANDLERS
// ============================================================

async function handleSetAccount(interaction) {
  const email = interaction.options.getString('email');
  const password = interaction.options.getString('password');

  config.auth.email = email;
  config.auth.password = password;
  saveConfig();

  // Mask the password in the response
  const masked = password.substring(0, 2) + '*'.repeat(Math.max(0, password.length - 4)) + password.slice(-2);

  await interaction.reply({
    ephemeral: true, // Only the user who ran this can see it
    embeds: [new EmbedBuilder()
      .setTitle('Account Updated')
      .setColor(0x57F287)
      .addFields(
        { name: 'Email', value: email, inline: true },
        { name: 'Password', value: masked, inline: true }
      )
      .setDescription('Credentials saved. Ready to use `/collect` or `/goldfind`.')
      .setFooter({ text: 'This message is only visible to you.' })
    ]
  });
}

async function handleSetMode(interaction) {
  const mode = interaction.options.getString('mode');
  config.tpahere.mode = mode;
  saveConfig();

  const desc = mode === 'tpahere'
    ? 'Bot will send `/tpahere <player>` to summon you to the gold zone.\n\n**You must click the green pane** to accept, or disable TPA confirms in `/settings` on the server.'
    : 'Bot will send `/tpa <player>` to teleport itself to you.\n\n**You must click the green pane** to accept, or disable TPA confirms in `/settings` on the server.';

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setTitle('TPA Mode Updated')
      .setColor(0x57F287)
      .addFields({ name: 'Mode', value: `/${mode}`, inline: true })
      .setDescription(desc)
    ]
  });
}

async function handleSetTarget(interaction) {
  const player = interaction.options.getString('player');
  config.tpahere.target = player;
  saveConfig();
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setTitle('TPA Target Updated')
      .setColor(0x57F287)
      .addFields({ name: 'Target', value: player, inline: true })
      .setDescription(`Gold finder will now use \`/${config.tpahere.mode || 'tpahere'} ${player}\` when a gold zone is found.`)
    ]
  });
}

async function handleResetData(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const files = ['data/rtp-coords.json', 'data/analysis-results.json', 'data/heatmap.png'];
  let deleted = 0;
  for (const f of files) {
    const p = path.resolve(__dirname, '..', f);
    if (fs.existsSync(p)) { fs.unlinkSync(p); deleted++; }
  }
  analysisResults = null;
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle('Data Reset')
      .setColor(0xFEE75C)
      .setDescription(`Deleted ${deleted} file(s). Fresh start!`)
    ]
  });
}

async function handleCollect(interaction) {
  if (currentOperation) {
    return interaction.reply({ content: `Already running: **${currentOperation}**. Use /stop first.`, ephemeral: true });
  }
  if (!config.auth.email) {
    return interaction.reply({ content: 'No account set! Use `/setaccount` first.', ephemeral: true });
  }

  const count = interaction.options.getInteger('count') || config.rtp.sampleCount;
  const delay = interaction.options.getInteger('delay') || config.rtp.delayMs;

  await interaction.deferReply();
  currentOperation = 'collecting';
  collector = new RTPCollector(config);
  collector.config.rtp.sampleCount = count;
  collector.config.rtp.delayMs = delay;

  const embed = new EmbedBuilder()
    .setTitle('RTP Collection Started')
    .setColor(0x00d2ff)
    .addFields(
      { name: 'Target', value: `${count} samples`, inline: true },
      { name: 'Delay', value: `${delay}ms`, inline: true },
      { name: 'Server', value: config.server.host, inline: true }
    )
    .setFooter({ text: 'Use /stop to cancel' });

  const msg = await interaction.editReply({ embeds: [embed] });
  progressMessage = msg;

  collector.onConnect = async (username) => {
    const e = new EmbedBuilder(embed.data).addFields({ name: 'Bot', value: username, inline: true });
    await msg.edit({ embeds: [e] });
  };

  let lastProgressUpdate = 0;
  collector.onProgress = async (current, total, elapsed, rate) => {
    const now = Date.now();
    if (now - lastProgressUpdate < 5000) return;
    lastProgressUpdate = now;
    const pct = ((current / total) * 100).toFixed(1);
    const eta = ((total - current) / rate);
    const etaStr = eta < 60 ? `${Math.round(eta)}m` : `${(eta / 60).toFixed(1)}h`;
    const e = new EmbedBuilder()
      .setTitle('RTP Collection In Progress')
      .setColor(0x00d2ff)
      .addFields(
        { name: 'Progress', value: `**${current} / ${total}** (${pct}%)`, inline: true },
        { name: 'Rate', value: `${rate}/min`, inline: true },
        { name: 'ETA', value: etaStr, inline: true },
        { name: 'Elapsed', value: `${(elapsed / 60000).toFixed(1)} min`, inline: true }
      );
    try { await msg.edit({ embeds: [e] }); } catch (_) {}
  };

  collector.onComplete = async (coords, duration) => {
    currentOperation = null; collector = null; analysisResults = null;
    const e = new EmbedBuilder()
      .setTitle('RTP Collection Complete!')
      .setColor(0x57F287)
      .addFields(
        { name: 'Samples', value: coords.length.toString(), inline: true },
        { name: 'Duration', value: `${(duration / 60000).toFixed(1)} min`, inline: true }
      )
      .setDescription('Next: `/analyze` to find gold zones, then `/heatmap` to see the map.');
    try { await msg.edit({ embeds: [e] }); } catch (_) {}
  };

  collector.onError = async (err) => {
    if (err.message.includes('Kicked')) {
      const e = new EmbedBuilder().setTitle('Bot Kicked').setColor(0xED4245).setDescription(err.message);
      try { await msg.edit({ embeds: [e] }); } catch (_) {}
    }
  };

  try {
    await collector.createBot();
    collector.setupListeners();
  } catch (err) {
    currentOperation = null;
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle('Failed to Connect').setColor(0xED4245).setDescription(`${err.message}`)]
    });
  }
}

async function handleStop(interaction) {
  if (!currentOperation) {
    return interaction.reply({ content: 'Nothing is running.', ephemeral: true });
  }
  const was = currentOperation;
  if (collector) collector.stop();
  if (goldFinder) goldFinder.stop();
  collector = null; goldFinder = null; currentOperation = null;
  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle('Stopped').setColor(0xFEE75C).setDescription(`Stopped ${was}.`)]
  });
}

async function handleStatus(interaction) {
  const coordsPath = path.resolve(__dirname, '..', 'data', 'rtp-coords.json');
  let coordCount = 0;
  if (fs.existsSync(coordsPath)) coordCount = JSON.parse(fs.readFileSync(coordsPath, 'utf-8')).length;
  const hasAnalysis = fs.existsSync(path.resolve(__dirname, '..', 'data', 'analysis-results.json'));
  const mode = config.tpahere.mode || 'tpahere';

  const e = new EmbedBuilder()
    .setTitle('RTP Mapper Status')
    .setColor(0x5865F2)
    .addFields(
      { name: 'Status', value: currentOperation || 'Idle', inline: true },
      { name: 'Samples', value: coordCount.toString(), inline: true },
      { name: 'Analysis', value: hasAnalysis ? 'Done' : 'No', inline: true },
      { name: 'TPA Target', value: config.tpahere.target, inline: true },
      { name: 'TPA Mode', value: `/${mode}`, inline: true },
      { name: 'Server', value: config.server.host, inline: true },
      { name: 'Account', value: config.auth.email ? 'Set' : 'Not set', inline: true }
    );

  if (!config.auth.email) {
    e.setDescription('**No account set!** Use `/setaccount` to add your Microsoft account.');
  }

  await interaction.reply({ embeds: [e] });
}

async function handleAnalyze(interaction) {
  const coordsPath = path.resolve(__dirname, '..', 'data', 'rtp-coords.json');
  if (!fs.existsSync(coordsPath)) {
    return interaction.reply({ content: 'No data! Run `/collect` first.', ephemeral: true });
  }
  await interaction.deferReply();
  try {
    const analyzer = new GridAnalyzer(config);
    analysisResults = analyzer.analyze('data/rtp-coords.json');
    const s = analysisResults.stats;
    const e = new EmbedBuilder()
      .setTitle('Analysis Complete!')
      .setColor(0x57F287)
      .addFields(
        { name: 'Samples', value: s.totalCoords.toString(), inline: true },
        { name: 'Grid', value: `${s.gridSize}x${s.gridSize}`, inline: true },
        { name: 'Max Density', value: s.maxCount.toString(), inline: true },
        { name: 'Occupied', value: s.occupiedCells.toString(), inline: true },
        { name: 'Empty', value: s.emptyCells.toString(), inline: true },
        { name: 'Threshold', value: s.threshold.toString(), inline: true }
      )
      .addFields({ name: 'Gold Zones', value: `**${s.goldZoneCount}** cells (${s.goldZonePercent}% of map)`, inline: false })
      .addFields({ name: 'Clusters', value: `**${s.clusterCount}** connected regions`, inline: true })
      .addFields({ name: 'Largest', value: `**${s.largestClusterSize}** cells (~${(s.largestClusterSize * s.cellSize * s.cellSize / 1000000).toFixed(1)}M blocks)`, inline: true })
      .setDescription('`/heatmap` for the map | `/topclusters` for best areas | `/goldfind` to search');
    await interaction.editReply({ embeds: [e] });
  } catch (err) {
    await interaction.editReply({ content: `Failed: ${err.message}` });
  }
}

async function handleHeatmap(interaction) {
  if (!analysisResults) {
    const rp = path.resolve(__dirname, '..', 'data', 'analysis-results.json');
    if (!fs.existsSync(rp)) {
      return interaction.reply({ content: 'No analysis! Run `/collect` then `/analyze`.', ephemeral: true });
    }
    const analyzer = new GridAnalyzer(config);
    analysisResults = analyzer.analyze('data/rtp-coords.json');
  }
  await interaction.deferReply();
  try {
    const generator = new HeatmapGenerator(config);
    const buffer = await generator.generate(analysisResults);
    const attachment = new AttachmentBuilder(buffer, { name: 'rtp-heatmap.png' });
    const e = new EmbedBuilder()
      .setTitle('RTP Heatmap')
      .setColor(0xFFD700)
      .setDescription(`**${analysisResults.stats.goldZoneCount}** gold zones out of **${analysisResults.stats.totalCells}** cells.`)
      .setImage('attachment://rtp-heatmap.png')
      .setFooter({ text: 'Gold borders = unexplored. /goldfind to search!' });
    await interaction.editReply({ embeds: [e], files: [attachment] });
  } catch (err) {
    await interaction.editReply({ content: `Failed: ${err.message}` });
  }
}

async function handleTopClusters(interaction) {
  const rp = path.resolve(__dirname, '..', 'data', 'analysis-results.json');
  if (!fs.existsSync(rp)) {
    return interaction.reply({ content: 'No analysis! `/collect` then `/analyze` first.', ephemeral: true });
  }
  const results = JSON.parse(fs.readFileSync(rp, 'utf-8'));
  const top = results.topClusters || [];
  if (top.length === 0) {
    return interaction.reply({ content: 'No clusters found.', ephemeral: true });
  }

  const e = new EmbedBuilder()
    .setTitle('Top Unexplored Areas')
    .setColor(0xFFD700)
    .setDescription('These are the **biggest** unexplored areas — most likely to have hidden bases.')
    .setFooter({ text: 'Use /goldfind to RTP until you land in one of these!' });

  for (let i = 0; i < Math.min(5, top.length); i++) {
    const c = top[i];
    const rank = ['1st', '2nd', '3rd', '4th', '5th'][i];
    e.addFields({
      name: `${rank} - ${c.size} cells`,
      value: `Center: X: **${c.x.toFixed(0)}**, Z: **${c.z.toFixed(0)}** (~${(c.sizeInBlocks / 1000000).toFixed(1)}M blocks)`,
      inline: false
    });
  }
  await interaction.reply({ embeds: [e] });
}

async function handleGoldFind(interaction) {
  if (currentOperation) {
    return interaction.reply({ content: `Already running: **${currentOperation}**. /stop first.`, ephemeral: true });
  }
  const rp = path.resolve(__dirname, '..', 'data', 'analysis-results.json');
  if (!fs.existsSync(rp)) {
    return interaction.reply({ content: 'No analysis! `/collect` then `/analyze` first.', ephemeral: true });
  }
  if (!config.auth.email) {
    return interaction.reply({ content: 'No account set! `/setaccount` first.', ephemeral: true });
  }

  const target = interaction.options.getString('target') || config.tpahere.target;
  const mode = config.tpahere.mode || 'tpahere';

  await interaction.deferReply();
  currentOperation = 'goldfinding';
  goldFinder = new GoldZoneFinder(config);

  const modeDesc = mode === 'tpahere'
    ? `Will send \`/${mode} ${target}\` to summon you to the gold zone.`
    : `Will send \`/${mode} ${target}\` so the bot teleports to you.`;

  const embed = new EmbedBuilder()
    .setTitle('Gold Zone Search Started')
    .setColor(0xFFD700)
    .addFields(
      { name: 'Target', value: target, inline: true },
      { name: 'Mode', value: `/${mode}`, inline: true },
      { name: 'Server', value: config.server.host, inline: true }
    )
    .setDescription(`RTPing until gold zone...\n${modeDesc}\n\n**Important:** When the TPA pops up, **click the green pane** to accept! Or run `/settings` on the server to disable TPA confirm menus.`)
    .setFooter({ text: '/stop to cancel' });

  const msg = await interaction.editReply({ embeds: [embed] });

  let lastUpdate = 0;
  goldFinder.onProgress = async (attempt, x, z, isGold) => {
    const now = Date.now();
    if (now - lastUpdate < 8000) return;
    lastUpdate = now;
    const e = new EmbedBuilder()
      .setTitle('Searching for Gold Zone...')
      .setColor(0xFEE75C)
      .addFields(
        { name: 'Attempts', value: attempt.toString(), inline: true },
        { name: 'Position', value: `X: ${x.toFixed(0)}, Z: ${z.toFixed(0)}`, inline: true },
        { name: 'Status', value: isGold ? 'GOLD ZONE!' : 'Normal zone', inline: true }
      );
    try { await msg.edit({ embeds: [e] }); } catch (_) {}
  };

  goldFinder.onFound = async (x, z, attempts) => {
    currentOperation = null; goldFinder = null;
    const cmdUsed = mode === 'tpahere' ? `/tpahere ${target}` : `/tpa ${target}`;
    const e = new EmbedBuilder()
      .setTitle('GOLD ZONE FOUND!')
      .setColor(0xFFD700)
      .setThumbnail('attachment://gold.png')
      .addFields(
        { name: 'Coordinates', value: `X: **${x.toFixed(0)}**, Z: **${z.toFixed(0)}**`, inline: true },
        { name: 'Attempts', value: attempts.toString(), inline: true },
        { name: 'Command Sent', value: cmdUsed, inline: true }
      )
      .setDescription(`The bot sent \`${cmdUsed}\`!\n\n**Click the green pane in-game to accept the TPA!**\nIf you disabled TPA confirms in \`/settings\`, you'll teleport automatically.`);

    // Gold zone thumbnail using Jimp (pure JS)
    const Jimp = require('jimp');
    const goldImg = new Jimp(64, 64, 0x00000000);
    goldImg.circle(32, 32, 28, 0xFFD700);
    // Skip text since Jimp font loading is complex - just use the gold circle
    const goldBuf = await goldImg.getBufferAsync(Jimp.MIME_PNG);
    const goldAttach = new AttachmentBuilder(Buffer.from(goldBuf), { name: 'gold.png' });
    try { await msg.edit({ embeds: [e], files: [goldAttach] }); } catch (_) {}
  };

  goldFinder.onError = async (err) => {
    if (err.message.includes('Kicked')) {
      const e = new EmbedBuilder().setTitle('Bot Kicked').setColor(0xED4245).setDescription(err.message);
      try { await msg.edit({ embeds: [e] }); } catch (_) {}
    }
  };

  try {
    goldFinder.loadAnalysis();
    if (target) goldFinder.config.tpahere.target = target;
    goldFinder.tpaMode = mode;
    await goldFinder.createBot();
    goldFinder.setupListeners();
  } catch (err) {
    currentOperation = null; goldFinder = null;
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle('Failed to Start').setColor(0xED4245).setDescription(err.message)]
    });
  }
}

// ============================================================
// LOGIN
// ============================================================
client.login(TOKEN).catch(err => {
  console.error('Login failed:', err.message);
});

// ============================================================
// HEALTH CHECK SERVER (keeps Render free tier alive)
// ============================================================
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: currentOperation || 'idle',
    uptime: process.uptime(),
    guilds: client.guilds?.cache.size || 0
  }));
});
server.listen(PORT, () => {
  console.log(`Health check server on port ${PORT}`);
});