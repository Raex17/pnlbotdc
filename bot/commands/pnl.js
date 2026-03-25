'use strict';

const {
  SlashCommandBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');

const { generateCard }   = require('../generate-card');
const { generateGif }    = require('../generate-gif');
const { getBackgrounds } = require('../storage');
const { fetchPnl }       = require('../fetch-pnl');

// ── In-memory session state ────────────────────────────────────────────────────
// Map<messageId, { data, bgPath, theme, hiddenFields: Set, expiresAt }>
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function isVideoUrl(url) {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      try { fs.unlinkSync(destPath); } catch {}
      reject(err);
    });
  });
}

function fmtUsd(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return '$0.00';
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtPct(v) {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtDuration(secs) {
  if (!secs || secs < 0) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function buildEmbed(data) {
  const pnlPositive = (data.pnlUsd ?? 0) >= 0;
  const color       = pnlPositive ? 0x5ce69f : 0xff6f7f;
  const duration    = data.openedAt && data.closedAt && data.closedAt > data.openedAt
    ? fmtDuration(data.closedAt - data.openedAt) : '—';

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${data.pairName} — PnL Card`)
    .addFields(
      { name: 'Net PnL',     value: (pnlPositive ? '+' : '') + fmtUsd(data.pnlUsd), inline: true },
      { name: 'PnL %',       value: data.pnlPct != null ? fmtPct(data.pnlPct) : '—', inline: true },
      { name: 'Duration',    value: duration, inline: true },
      { name: 'Deposited',   value: fmtUsd(data.depositedUsd), inline: true },
      { name: 'Withdrawn',   value: fmtUsd(data.withdrawnUsd), inline: true },
      { name: 'Claimed Fees',value: fmtUsd(data.claimedFeesUsd), inline: true },
      { name: 'Bin Step',    value: data.binStep != null ? String(data.binStep) : '—', inline: true },
      { name: 'Base Fee',    value: data.baseFeePct != null ? `${data.baseFeePct}%` : '—', inline: true },
    )
    .setFooter({ text: '#trackooor • Pick your options below, then click Generate Card' });
}

function buildComponents(hiddenFields, currency = 'USD') {
  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('pnl_hide_fields')
      .setPlaceholder('Hide fields on the card…')
      .setMinValues(0)
      .setMaxValues(5)
      .addOptions([
        { label: 'Time',      value: 'time',      default: hiddenFields.has('time')      },
        { label: 'Deposited', value: 'deposited', default: hiddenFields.has('deposited') },
        { label: 'Bin Step',  value: 'binstep',   default: hiddenFields.has('binstep')   },
        { label: 'Base Fee',  value: 'basefee',   default: hiddenFields.has('basefee')   },
        { label: 'PnL %',     value: 'pnlpct',    default: hiddenFields.has('pnlpct')    },
      ])
  );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pnl_show_all')       .setLabel('✅ Show All')      .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('pnl_currency_usd')   .setLabel('🇺🇸 USD')          .setStyle(currency === 'USD' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pnl_currency_idr')   .setLabel('🇮🇩 IDR')          .setStyle(currency === 'IDR' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pnl_generate')       .setLabel('🎴 Generate Card') .setStyle(ButtonStyle.Primary),
  );

  return [selectRow, actionRow];
}

async function fetchIdrRate() {
  try {
    const res  = await fetch('https://open.er-api.com/v6/latest/USD');
    const json = await res.json();
    return Number(json?.rates?.IDR || 0);
  } catch {
    return 0;
  }
}

// ── Command definition ────────────────────────────────────────────────────────

const data = new SlashCommandBuilder()
  .setName('pnl')
  .setDescription('Generate a PnL card for a remove-liquidity transaction')
  .addStringOption((opt) =>
    opt.setName('txhash')
      .setDescription('Remove-liquidity transaction signature')
      .setRequired(true)
  )
  .addAttachmentOption((opt) =>
    opt.setName('bg')
      .setDescription('Custom background image or video (optional)')
      .setRequired(false)
  );

// ── Command execute ───────────────────────────────────────────────────────────

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const txSig    = interaction.options.getString('txhash');
  const bgAttach = interaction.options.getAttachment('bg');

  // Fetch PnL data
  let pnlData;
  try {
    pnlData = await fetchPnl(txSig, process.env.RPC_URL);
  } catch (err) {
    return interaction.editReply(`❌ Error: ${err.message}`);
  }

  // Download custom bg attachment if provided (saved to temp, stored in session)
  let bgPath  = null;
  let isVideo = false;
  if (bgAttach) {
    const ext     = path.extname(bgAttach.name || '').toLowerCase() || '.png';
    const tmpFile = path.join(os.tmpdir(), `pnl_bg_${crypto.randomBytes(8).toString('hex')}${ext}`);
    try {
      await download(bgAttach.url, tmpFile);
      bgPath  = tmpFile;
      isVideo = isVideoUrl(bgAttach.url) || isVideoUrl(bgAttach.name || '');
    } catch {
      bgPath = null;
    }
  }

  const embed      = buildEmbed(pnlData);
  const components = buildComponents(new Set(), 'USD');

  const sent = await interaction.editReply({ embeds: [embed], components });

  sessions.set(sent.id, {
    data:            pnlData,
    bgPath,
    isVideo,
    currency:        'USD',
    hiddenFields:    new Set(),
    userAvatarUrl:   interaction.user.displayAvatarURL({ size: 64, extension: 'png' }),
    userDisplayName: interaction.member?.displayName || interaction.user.displayName || interaction.user.username,
    expiresAt:       Date.now() + SESSION_TTL_MS,
  });
}

// ── Interaction handler ───────────────────────────────────────────────────────

async function handleInteraction(interaction) {
  const msgId   = interaction.message.id;
  const session = sessions.get(msgId);

  if (!session) {
    return interaction.reply({ content: 'Session expired. Please run `/pnl` again.', flags: MessageFlags.Ephemeral });
  }

  // Update session state
  if (interaction.isStringSelectMenu() && interaction.customId === 'pnl_hide_fields') {
    session.hiddenFields = new Set(interaction.values);
  } else if (interaction.isButton()) {
    if (interaction.customId === 'pnl_show_all') {
      session.hiddenFields = new Set();
    } else if (interaction.customId === 'pnl_currency_usd') {
      session.currency = 'USD';
    } else if (interaction.customId === 'pnl_currency_idr') {
      session.currency = 'IDR';
    }
  }

  // Generate card
  if (interaction.isButton() && interaction.customId === 'pnl_generate') {
    await interaction.deferUpdate();

    // Resolve background
    let bgPath = session.bgPath;
    if (!bgPath) {
      const bgs    = getBackgrounds();
      const pnlPos = (session.data.pnlUsd ?? 0) >= 0;
      const stored = pnlPos ? bgs.profit : bgs.loss;
      if (stored && fs.existsSync(stored)) bgPath = stored;
    }

    const isVideo = session.isVideo || (bgPath ? isVideoUrl(bgPath) : false);

    // Fetch IDR rate if needed
    let rate = 1;
    if (session.currency === 'IDR') {
      rate = await fetchIdrRate();
      if (!rate) return interaction.followUp({ content: '❌ Could not fetch IDR exchange rate.', ephemeral: true });
    }

    const user = {
      avatarUrl:   session.userAvatarUrl,
      displayName: session.userDisplayName,
    };

    let buf;
    try {
      if (isVideo && bgPath) {
        buf = await generateGif(bgPath, session.data, { hiddenFields: session.hiddenFields });
      } else {
        buf = await generateCard(session.data, {
          bgPath,
          hiddenFields: session.hiddenFields,
          currency:     session.currency,
          rate,
          user,
        });
      }
    } catch (err) {
      return interaction.followUp({ content: `❌ Render failed: ${err.message}`, ephemeral: true });
    }

    const fileName = isVideo ? 'pnl-card.gif' : 'pnl-card.png';
    const file     = new AttachmentBuilder(buf, { name: fileName });

    // Post card publicly, then dismiss the ephemeral controls
    await interaction.followUp({ files: [file] });
    await interaction.editReply({ content: '✅ Card generated.', embeds: [], components: [] });
    sessions.delete(msgId);
    return;
  }

  // For dropdown / currency toggle: update controls to reflect new state
  await interaction.deferUpdate();
  const components = buildComponents(session.hiddenFields, session.currency);
  await interaction.editReply({ components });
  session.expiresAt = Date.now() + SESSION_TTL_MS;
}

module.exports = { data, execute, handleInteraction };
