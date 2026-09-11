require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, Events,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelType, PermissionsBitField,
  REST, Routes, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SectionBuilder, ThumbnailBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder, AttachmentBuilder,
  MessageFlagsBitField, SeparatorSpacingSize
} = require('discord.js');

// === CONFIG ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || null;
const CLAIMED_CATEGORY_ID = process.env.CLAIMED_CATEGORY_ID || null;
const CHEF_ROLE_ID = process.env.CHEF_ROLE_ID || '1541821804576907415';
const PAID_ROLE_ID = '1541821517887709194';
const PANEL_CHANNEL_ID = process.env.PANEL_CHANNEL_ID || null;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID || '1545395198517968937';
const SUCCESSFUL_CHECKOUTS_CHANNEL_ID = process.env.SUCCESSFUL_CHECKOUTS_CHANNEL_ID || '1547810040486825994';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { spawn } = require('child_process');
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
// Postgres for persistence on Railway (falls back to files locally)
const { Pool } = require('pg');
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
if (pool) pool.on('error', e => console.log('[DB] pool error', e.message));
async function dbInit() {
  if (!pool) return;
  try { await pool.query(`CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value JSONB)`); console.log('[DB] kv_store ready'); } catch(e){ console.log('[DB] init fail', e.message); }
}
async function dbGet(key, fallback) {
  if (!pool) return fallback;
  try { const r = await pool.query('SELECT value FROM kv_store WHERE key=$1', [key]); if (r.rows[0]) return r.rows[0].value; } catch(e){ console.log('[DB] get',key,e.message); }
  return fallback;
}
async function dbSet(key, value) {
  if (!pool) return;
  try { await pool.query('INSERT INTO kv_store (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, JSON.stringify(value)]); } catch(e){ console.log('[DB] set',key,e.message); }
}
// Discord channel persistence fallback (no DB/volume needed) - survives Railway restarts
async function getDataChannel() {
  const guild = client.guilds.cache.get(GUILD_ID) || client.guilds.cache.first();
  if (!guild) return null;
  let ch = guild.channels.cache.find(c => c.name === 'bot-data');
  if (!ch) {
    try {
      await guild.channels.fetch();
      ch = guild.channels.cache.find(c => c.name === 'bot-data');
    } catch {}
  }
  if (!ch) {
    try {
      ch = await guild.channels.create({ name: 'bot-data', type: ChannelType.GuildText, permissionOverwrites: [{ id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }, { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }] });
      console.log('[DATA] created #bot-data');
    } catch(e){ console.log('[DATA] create fail', e.message); return null; }
  }
  return ch;
}
async function saveToDiscord(key, value) {
  try {
    const ch = await getDataChannel();
    if (!ch) return;
    const content = "```json:" + key + "\n" + JSON.stringify(value, null, 2) + "\n```";
    const msgs = await ch.messages.fetch({ limit: 100 }).catch(()=>null);
    const existing = msgs?.find(m => m.author.id === client.user.id && m.content.startsWith("```json:" + key));
    if (existing) await existing.edit(content).catch(()=>{});
    else await ch.send(content).catch(()=>{});
  } catch(e){ console.log('[DATA] discord save',e.message); }
}
async function loadFromDiscord() {
  try {
    const ch = await getDataChannel();
    if (!ch) return;
    const msgs = await ch.messages.fetch({ limit: 100 }).catch(()=>null);
    if (!msgs) return;
    for (const m of msgs.values()) {
      if (m.author.id !== client.user.id) continue;
      const match = m.content.match(/```json:(\w+)\n([\s\S]+)\n```/);
      if (!match) continue;
      const k = match[1]; const v = JSON.parse(match[2]);
      if (k === 'chef_balances') Object.assign(chefBalances, v);
      else if (k === 'daily_orders') Object.assign(dailyData, v);
      else if (k === 'vouch_points') Object.assign(vouchPoints, v);
      else if (k === 'status' && v.open !== undefined) { isOpen = v.open; statusGifMessageId = v.gifMessageId; }
      else if (k === 'clock' && v.clockedIn) { clockedIn.clear(); v.clockedIn.forEach(id=>clockedIn.add(id)); }
      else if (k === 'claimed') { claimedTickets.clear(); for (const [kk,vv] of Object.entries(v)) claimedTickets.set(kk,vv); }
    }
    console.log('[DATA] discord loaded');
  } catch(e){ console.log('[DATA] load fail',e.message); }
}
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
let isOpen = true;
let statusGifMessageId = null;
try {
  if (fs.existsSync(STATUS_FILE)) {
    const data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    if (typeof data.open === 'boolean') isOpen = data.open;
    if (data.gifMessageId) statusGifMessageId = data.gifMessageId;
  }
} catch {}
function saveStatus(open, gifId = statusGifMessageId) {
  isOpen = open;
  if (gifId !== undefined) statusGifMessageId = gifId;
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ open, gifMessageId: statusGifMessageId }, null, 2)); } catch {}
  dbSet('status', { open, gifMessageId: statusGifMessageId });
  saveToDiscord('status', { open, gifMessageId: statusGifMessageId });
}
// Platform toggles (which deal types appear on the order panel)
const PLATFORMS_FILE = path.join(DATA_DIR, 'platforms.json');
let platforms = { '10for30': true, 'doordash': true, 'ubereats': true };
try {
  if (fs.existsSync(PLATFORMS_FILE)) {
    const data = JSON.parse(fs.readFileSync(PLATFORMS_FILE, 'utf8'));
    if (data && typeof data === 'object') {
      for (const key of ['10for30', 'doordash', 'ubereats']) {
        if (typeof data[key] === 'boolean') platforms[key] = data[key];
      }
    }
  }
} catch {}
function savePlatforms() {
  try { fs.writeFileSync(PLATFORMS_FILE, JSON.stringify(platforms, null, 2)); } catch {}
  dbSet('platforms', platforms);
  saveToDiscord('platforms', platforms);
}
// Clock in/out for chefs
const CLOCK_FILE = path.join(DATA_DIR, 'clock.json');
const clockedIn = new Set();
try {
  if (fs.existsSync(CLOCK_FILE)) {
    const d = JSON.parse(fs.readFileSync(CLOCK_FILE, 'utf8'));
    if (Array.isArray(d.clockedIn)) d.clockedIn.forEach(id => clockedIn.add(id));
  }
} catch {}
function saveClock() {
  try { fs.writeFileSync(CLOCK_FILE, JSON.stringify({ clockedIn: [...clockedIn] }, null, 2)); } catch {}
  dbSet('clock', { clockedIn: [...clockedIn] });
  saveToDiscord('clock', { clockedIn: [...clockedIn] });
}
function getChefPings() {
  if (clockedIn.size === 0) return '';
  return [...clockedIn].map(id => `<@${id}>`).join(' ');
}
// Balances for chefs - $2 per complete
const BALANCE_FILE = path.join(DATA_DIR, 'chef_balances.json');
let chefBalances = {};
try {
  if (fs.existsSync(BALANCE_FILE)) chefBalances = JSON.parse(fs.readFileSync(BALANCE_FILE, 'utf8'));
} catch {}
function saveBalances() { try { fs.writeFileSync(BALANCE_FILE, JSON.stringify(chefBalances, null, 2)); } catch {} dbSet('chef_balances', chefBalances); saveToDiscord('chef_balances', chefBalances); }
function getChefBalance(uid) {
  if (!chefBalances[uid]) chefBalances[uid] = { balance: 0, totalOrders: 0 };
  return chefBalances[uid];
}
function countClaimedBy(uid) {
  let c = 0;
  for (const [chId, claimer] of [...claimedTickets.entries()]) {
    if (claimer !== uid) continue;
    const ch = client.channels.cache.get(chId);
    if (!ch) { claimedTickets.delete(chId);
      saveClaimed(); continue; }
    if (ch.parentId !== CLAIMED_CATEGORY_ID) { claimedTickets.delete(chId);
      saveClaimed(); continue; }
    c++;
  }
  // prune stale and persist if needed
  try { saveClaimed(); } catch {}
  return c;
}
function getClaimCountDebug(uid) {
  const all = [...claimedTickets.entries()].filter(([,v])=>v===uid);
  return `${all.length} total, ${countClaimedBy(uid)} active (in Claimed)`;
}
const ratingStore = new Map(); // ratingMessageId -> { customerId, chefId }
// Chef ratings - persistent star ratings
const RATINGS_FILE = path.join(DATA_DIR, 'chef_ratings.json');
let chefRatings = {}; // chefId -> { totalStars, count, avg, distribution:{1:0..5:0} }
try { if (fs.existsSync(RATINGS_FILE)) chefRatings = JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8')); } catch {}
function saveChefRatings() { try { fs.writeFileSync(RATINGS_FILE, JSON.stringify(chefRatings, null, 2)); } catch {} dbSet('chef_ratings', chefRatings); saveToDiscord('chef_ratings', chefRatings); }
function addChefRating(chefId, stars, customerId) {
  if (!chefRatings[chefId]) chefRatings[chefId] = { totalStars: 0, count: 0, distribution: { '1':0,'2':0,'3':0,'4':0,'5':0 } };
  const r = chefRatings[chefId];
  r.totalStars += stars;
  r.count += 1;
  r.distribution[String(stars)] = (r.distribution[String(stars)]||0)+1;
  // keep last 20 ratings detail for recent view (optional)
  if (!r.recent) r.recent = [];
  r.recent.unshift({ stars, customerId, ts: Date.now() });
  if (r.recent.length > 20) r.recent = r.recent.slice(0,20);
  saveChefRatings();
}
function getChefRatingStats(chefId) {
  const r = chefRatings[chefId];
  if (!r || !r.count) return { count: 0, avg: 0, totalStars: 0, distribution: { '1':0,'2':0,'3':0,'4':0,'5':0 } };
  return { count: r.count, avg: r.totalStars / r.count, totalStars: r.totalStars, distribution: r.distribution, recent: r.recent||[] };
}
// Vouch points
const VOUCH_POINTS_FILE = path.join(DATA_DIR, 'vouch_points.json');
let vouchPoints = {};
try { if (fs.existsSync(VOUCH_POINTS_FILE)) vouchPoints = JSON.parse(fs.readFileSync(VOUCH_POINTS_FILE, 'utf8')); } catch {}
function saveVouchPoints() { try { fs.writeFileSync(VOUCH_POINTS_FILE, JSON.stringify(vouchPoints, null, 2)); } catch {} dbSet('vouch_points', vouchPoints); saveToDiscord('vouch_points', vouchPoints); }
function addVouchPoints(uid, pts = 10) { if (!vouchPoints[uid]) vouchPoints[uid] = 0; vouchPoints[uid] += pts; saveVouchPoints(); return vouchPoints[uid]; }
async function watermarkBuffer(buf) {
  try {
    const image = sharp(buf);
    const meta = await image.metadata();
    const w = meta.width || 600;
    const h = meta.height || 400;
    const fontSize = Math.round(Math.min(w, h) / 6);
    const svg = `<svg width="${w}" height="${h}"><text x="50%" y="50%" font-family="Arial Black, sans-serif" font-size="${fontSize}" fill="white" opacity="0.32" text-anchor="middle" dominant-baseline="middle" transform="rotate(-22 ${w/2} ${h/2})">Munchies</text></svg>`;
    return await image.composite([{ input: Buffer.from(svg), gravity: 'centre' }]).jpeg({ quality: 90 }).toBuffer();
  } catch (e) { console.log('[X] watermark', e.message); return buf; }
}
// Daily orders tracking for /today
const DAILY_FILE = path.join(DATA_DIR, 'daily_orders.json');
let dailyData = {};
try { if (fs.existsSync(DAILY_FILE)) dailyData = JSON.parse(fs.readFileSync(DAILY_FILE, 'utf8')); } catch {}
function saveDaily() { try { fs.writeFileSync(DAILY_FILE, JSON.stringify(dailyData, null, 2)); } catch {} dbSet('daily_orders', dailyData); saveToDiscord('daily_orders', dailyData); }
function formatHour(h) { const ampm = h >= 12 ? 'PM' : 'AM'; const hr = h % 12 || 12; return `${hr} ${ampm}`; }
function logOrderToday(chefId) {
  const dateStr = new Date().toISOString().split('T')[0];
  if (!dailyData[dateStr]) dailyData[dateStr] = { orders: [] };
  dailyData[dateStr].orders.push({ chefId, timestamp: Date.now(), hour: new Date().getHours() });
  saveDaily();
}
function getTodayStats() {
  const dateStr = new Date().toISOString().split('T')[0];
  const data = dailyData[dateStr];
  if (!data || !data.orders.length) return { dateStr, total: 0, busiest: null, top: [] };
  const total = data.orders.length;
  const byChef = {};
  const byHour = {};
  for (const o of data.orders) {
    byChef[o.chefId] = (byChef[o.chefId] || 0) + 1;
    const label = formatHour(o.hour);
    byHour[label] = (byHour[label] || 0) + 1;
  }
  let busiest = null;
  let maxHour = 0;
  for (const [h, c] of Object.entries(byHour)) { if (c > maxHour) { maxHour = c; busiest = { label: h, count: c }; } }
  const top = Object.entries(byChef).sort((a,b)=>b[1]-a[1]).slice(0, 4);
  return { dateStr, total, busiest, top };
}
async function updateStatusGif(open) {
  try {
    const guild = client.guilds.cache.get(GUILD_ID) || client.guilds.cache.first();
    if (!guild) return;
    let ch = null;
    try { ch = await guild.channels.fetch(STATUS_CHANNEL_ID); } catch {}
    if (!ch) ch = guild.channels.cache.get(STATUS_CHANNEL_ID);
    if (!ch) ch = guild.channels.cache.find(c => c.name.includes('status'));
    if (!ch) {
      // try fresh fetch all
      try { await guild.channels.fetch(); ch = guild.channels.cache.find(c => c.name.includes('status')); } catch {}
    }
    if (!ch) { console.log('[X] status gif channel not found'); return; }
    if (statusGifMessageId) {
      try {
        const old = await ch.messages.fetch(statusGifMessageId).catch(()=>null);
        if (old) await old.delete().catch(()=>{});
      } catch {}
      statusGifMessageId = null;
    }
    // Cleanup any stale @everyone CLOSED messages left from before fix
    try {
      const recent = await ch.messages.fetch({ limit: 10 }).catch(()=>null);
      if (recent) {
        for (const m of recent.values()) {
          if (m.author.id === client.user.id && m.content.includes('@everyone') && m.embeds[0]?.description?.includes('CLOSED')) {
            await m.delete().catch(()=>{});
          }
        }
      }
    } catch {}
    const gifUrl = open
      ? 'https://media1.tenor.com/m/Ciazvs6FzuAAAAAC/spongebob-open.gif'
      : 'https://media1.tenor.com/m/9Wq1jcXr_wUAAAAC/spongebob-are-you-open.gif';
    // Download gif and upload as attachment so Discord always displays it (external tenor URLs fail to embed)
    try {
      const res = await fetch(gifUrl);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const filename = open ? 'open.gif' : 'closed.gif';
      const attachment = new AttachmentBuilder(buf, { name: filename });
      const embed = new EmbedBuilder()
        .setDescription(open ? 'The restaurant is now OPEN!' : 'The restaurant is now CLOSED!')
        .setImage(`attachment://${filename}`)
        .setColor(open ? 0x57F287 : 0xED4245)
        .setFooter({ text: open ? 'OPEN!' : 'CLOSED' });
      // No @everyone for either open or closed per request
      const msg = await ch.send({ embeds: [embed], files: [attachment] }).catch(e=>{ console.log('[X] gif send attach failed', e.message); return null; });
      if (msg) saveStatus(open, msg.id);
      else saveStatus(open, null);
      return;
    } catch (e) {
      console.log('[X] gif fetch/attach failed', e.message, 'falling back to URL');
    }
    // fallback direct URL embed — no ping
    const embed = new EmbedBuilder()
      .setDescription(open ? 'The restaurant is now OPEN!' : 'The restaurant is now CLOSED!')
      .setImage(gifUrl)
      .setColor(open ? 0x57F287 : 0xED4245)
      .setFooter({ text: open ? 'OPEN!' : 'CLOSED' });
    const msg = await ch.send({ embeds: [embed] }).catch(e=>{ console.log('[X] gif send fallback failed', e.message); return null; });
    if (msg) saveStatus(open, msg.id);
    else saveStatus(open, null);
  } catch(e){ console.log('[X] updateStatusGif', e.message); }
}
async function updateStatusChannel(open) {
  try {
    const guild = client.guilds.cache.get(GUILD_ID) || client.guilds.cache.first();
    if (!guild) return;
    // fresh fetch to get current name (cache may be stale)
    let ch = null;
    try { ch = await guild.channels.fetch(STATUS_CHANNEL_ID); } catch {}
    if (!ch) ch = guild.channels.cache.get(STATUS_CHANNEL_ID) || guild.channels.cache.find(c => c.name.includes('status'));
    if (!ch) {
      console.log(`[X] Status channel ${STATUS_CHANNEL_ID} not found`);
      return;
    }
    const newName = open ? '🟢-status' : '🔴-status';
    if (ch.name === newName) {
      console.log(`[i] Status channel already ${newName}`);
      return;
    }
    // Discord rate-limits channel renames (2 per 10m) - use timeout so we don't hang the interaction
    const rename = ch.setName(newName);
    const timeout = new Promise((_, rej) => setTimeout(()=> rej(new Error('rename timeout (rate limited?)')), 8000));
    try {
      await Promise.race([rename, timeout]);
      console.log(`[i] Status channel set to ${newName} (${open ? 'OPEN' : 'CLOSED'})`);
    } catch (e) {
      console.log(`[X] rename status failed: ${e.message} - will retry in 10s`);
      // retry once after delay (handles 2/10m rate limit)
      setTimeout(async () => {
        try {
          const fresh = await guild.channels.fetch(STATUS_CHANNEL_ID).catch(()=>null);
          const target = fresh || ch;
          if (target.name !== newName) await target.setName(newName);
          console.log(`[i] Retry status rename to ${newName} succeeded`);
        } catch (err) { console.log('[X] retry rename failed', err.message); }
      }, 10000);
    }
  } catch (e) { console.log('[X] updateStatusChannel', e.message); }
}

if (!BOT_TOKEN) {
  console.error('[X] Missing BOT_TOKEN in .env - this is your LEGIT bot token (not selfbot token)');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

// Ticket claim tracker: channelId -> userId (persisted to survive restarts)
const CLAIMED_FILE = path.join(DATA_DIR, 'claimed.json');
const claimedTickets = new Map();
try {
  if (fs.existsSync(CLAIMED_FILE)) {
    const d = JSON.parse(fs.readFileSync(CLAIMED_FILE, 'utf8'));
    for (const [k,v] of Object.entries(d)) claimedTickets.set(k,v);
  }
} catch {}
function saveClaimed() { try { fs.writeFileSync(CLAIMED_FILE, JSON.stringify(Object.fromEntries(claimedTickets), null, 2)); } catch {} dbSet('claimed', Object.fromEntries(claimedTickets)); saveToDiscord('claimed', Object.fromEntries(claimedTickets)); }
const ticketStore = new Map(); // channelId -> { deal, orderData, user }

function hasChefPermission(member, guild) {
  if (!member || !guild) return false;
  // Direct chef role
  if (member.roles.cache.has(CHEF_ROLE_ID)) return true;
  // Higher role via hierarchy - any role with position >= chef role
  const chefRole = guild.roles.cache.get(CHEF_ROLE_ID);
  if (!chefRole) {
    // Fallback: if chef role not found, deny (secures tickets)
    return false;
  }
  return member.roles.highest.position >= chefRole.position;
}

function getDealInfo(value) {
  if (value === 'deal_10for30') return { label: '10 FOR 30 DEALS 🥬', emoji: '🥬', short: '10for30', color: 0x2ECC71 };
  if (value === 'deal_doordash' || value === 'deal_redapp') return { label: value === 'deal_doordash' ? 'DOORDASH 🚗' : '60% off RedApp', emoji: '🚗', short: 'doordash', color: 0xE74C3C, modalKey: 'doordash' };
  if (value === 'deal_ubereats') return { label: 'Uber Eats 🛵', emoji: '🛵', short: 'ubereats', color: 0x06C167 };
  return { label: value, emoji: '🎟️', short: 'deal', color: 0x3498DB };
}

function buildOrderModal(dealValue) {
  if (dealValue === 'deal_ubereats') {
    const modal = new ModalBuilder().setCustomId('order_ubereats').setTitle('Please fill this out');
    const addressInput = new TextInputBuilder().setCustomId('address').setLabel('What is your full address').setPlaceholder('1474 Summer ST... (example)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);
    const storeInput = new TextInputBuilder().setCustomId('store').setLabel('What restaurant are you ordering from?').setPlaceholder('McDonalds..').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100);
    const totalInput = new TextInputBuilder().setCustomId('total').setLabel('What is your total?').setPlaceholder('$23..').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50);
    const paymentInput = new TextInputBuilder().setCustomId('payment').setLabel('What is your payment method.').setPlaceholder('Cashapp..').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100);
    modal.addComponents(
      new ActionRowBuilder().addComponents(addressInput),
      new ActionRowBuilder().addComponents(storeInput),
      new ActionRowBuilder().addComponents(totalInput),
      new ActionRowBuilder().addComponents(paymentInput)
    );
    return modal;
  }
  const is10for30 = dealValue === 'deal_10for30';
  const modal = new ModalBuilder()
    .setCustomId(is10for30 ? 'order_10for30' : 'order_doordash')
    .setTitle('Please fill this out');

  const addressInput = new TextInputBuilder()
    .setCustomId('address')
    .setLabel('What is your full address')
    .setPlaceholder('1474 Summer ST... (example)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(200);

  const totalInput = new TextInputBuilder()
    .setCustomId('total')
    .setLabel('What is your total?')
    .setPlaceholder('$23..')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(50);

  const paymentInput = new TextInputBuilder()
    .setCustomId('payment')
    .setLabel('What is your payment method.')
    .setPlaceholder('Cashapp..')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100);

  if (is10for30) {
    const storeInput = new TextInputBuilder()
      .setCustomId('store')
      .setLabel('What store are you ordering from?')
      .setPlaceholder('dominos..')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(100);

    modal.addComponents(
      new ActionRowBuilder().addComponents(addressInput),
      new ActionRowBuilder().addComponents(storeInput),
      new ActionRowBuilder().addComponents(totalInput),
      new ActionRowBuilder().addComponents(paymentInput)
    );
  } else {
    // DOORDASH variant: address, total, grouplink, payment
    const groupLinkInput = new TextInputBuilder()
      .setCustomId('grouplink')
      .setLabel('What is your group link?')
      .setPlaceholder('https://doordash.com/group/...')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(300);

    modal.addComponents(
      new ActionRowBuilder().addComponents(addressInput),
      new ActionRowBuilder().addComponents(totalInput),
      new ActionRowBuilder().addComponents(groupLinkInput),
      new ActionRowBuilder().addComponents(paymentInput)
    );
  }
  return modal;
}

function buildTicketContainer(deal, orderData, user, claimedBy = null) {
  const container = new ContainerBuilder().setAccentColor(deal.color);
  // Header like direct order bot - MUNCHIES · ORDER SERVICE with animated thumbnail
  const dealGifs = {
    '10for30': 'https://media1.tenor.com/m/dGU8KIYkB3wAAAAC/pizza-anime.gif',
    'doordash': 'https://media1.tenor.com/m/Ciazvs6FzuAAAAAC/spongebob-open.gif',
    'ubereats': 'https://media1.tenor.com/m/TEx1ai0W_7MAAAAC/pizza-pizza-gif.gif'
  };
  const gifForDeal = dealGifs[deal.short] || dealGifs['10for30'];
  const header = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# MUNCHIES · ORDER SERVICE\n## ${deal.emoji} ${deal.label} is selected`))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL('attachment://ticket.gif').setDescription(deal.label));
  container.addSectionComponents(header);
  const chefPings = getChefPings();
  const pingLine = chefPings ? `Hey <@${user.id}> ${chefPings}` : `Hey <@${user.id}>`;
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${pingLine} — thanks for ordering!`));
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Restaurant locked in.**`));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`📍 Add the recipient and delivery address to keep moving.`));
  if (orderData) {
    const lines = [];
    if (orderData.address) lines.push(`📍 **Address:** ${orderData.address}`);
    if (orderData.store) lines.push(`🏪 **Store:** ${orderData.store}`);
    if (orderData.total) lines.push(`💰 **Total:** ${orderData.total}`);
    if (orderData.grouplink) lines.push(`🔗 **Group Link:** ${orderData.grouplink}`);
    if (orderData.payment) lines.push(`💳 **Payment:** ${orderData.payment}`);
    if (lines.length) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Accepted: \`Street|City|ST|ZIP\` or \`Street, City, ST ZIP\``));
    }
  }
  if (claimedBy) {
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`✅ **Claimed by <@${claimedBy}>** — this chef will assist you 1:1.`));
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`*A chef will claim your ticket shortly. — User ID: \`${user.id}\`*`));
  }
  const row = new ActionRowBuilder().addComponents(
    claimedBy
      ? new ButtonBuilder().setCustomId('unclaim_ticket').setLabel('Unclaim').setStyle(ButtonStyle.Secondary).setEmoji('↩️')
      : new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claim Ticket').setStyle(ButtonStyle.Success).setEmoji('🙋'),
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close').setStyle(ButtonStyle.Secondary).setEmoji('🔒')
  );
  container.addActionRowComponents(row);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Ticket for ${user.tag} • <t:${Math.floor(Date.now()/1000)}:R>`));
  return container;
}
async function getTicketGifAttachment(dealShort) {
  const map = {
    '10for30': 'https://media1.tenor.com/m/dGU8KIYkB3wAAAAC/pizza-anime.gif',
    'doordash': 'https://media1.tenor.com/m/Ciazvs6FzuAAAAAC/spongebob-open.gif',
    'ubereats': 'https://media1.tenor.com/m/TEx1ai0W_7MAAAAC/pizza-pizza-gif.gif'
  };
  const url = map[dealShort] || map['10for30'];
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return new AttachmentBuilder(buf, { name: 'ticket.gif' });
  } catch { return null; }
}

async function createTicket(guild, user, dealValue, orderData) {
  const deal = getDealInfo(dealValue);

  const existing = guild.channels.cache.find(c => c.topic && c.topic.includes(user.id) && c.parentId === TICKET_CATEGORY_ID);
  if (existing) {
    return { alreadyExists: true, channel: existing };
  }

  const channelName = `ticket-${user.username.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${deal.short}`.slice(0, 90);

  const permissionOverwrites = [
    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ManageMessages] }
  ];
  if (CHEF_ROLE_ID) {
    permissionOverwrites.push({ id: CHEF_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY_ID || null,
    topic: `Ticket for ${user.tag} (${user.id}) | Deal: ${deal.label}`,
    permissionOverwrites
  });

  ticketStore.set(channel.id, { deal, orderData, user });

  const container = buildTicketContainer(deal, orderData, user, null);
  const gifAtt = await getTicketGifAttachment(deal.short);
  const pingIds = [...clockedIn];
  const uniqueUsers = [...new Set([user.id, ...pingIds])];
  const files = gifAtt ? [gifAtt] : [];
  await channel.send({
    components: [container],
    flags: MessageFlagsBitField.Flags.IsComponentsV2,
    files,
    allowedMentions: { users: uniqueUsers }
  });

  return { channel, deal };
}

function buildOrderConfirmedContainer(store, result, addressRaw, cart, method) {
  const storeName = store === 'dominos' ? "Domino's" : store === 'papajohns' ? "Papa John's" : store === 'wingstop' ? "Wingstop" : store === 'pandaexpress' ? "Panda Express" : store;
  const storeId = result.store_id || '5075';
  const total = result.total != null ? `$${Number(result.total).toFixed(2)}` : '$34.65';
  const eta = result.pricing?.raw?.Order?.EstimatedWaitMinutes || result.raw?.EstimatedWaitMinutes || '25-35';
  const etaText = String(eta).includes('-') ? String(eta) : '35';
  const ticketId = result.pricing?.raw?.Order?.OrderID || result.order_json?.Order?.OrderID || `${storeId}5300166504093`;
  const shortTicket = String(ticketId).slice(0,16).toUpperCase();
  const container = new ContainerBuilder().setAccentColor(0x57F287);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🔴 Order Confirmed`));
  // Store line + meta lines like screenshot
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`🏪 ${storeName} #${storeId}`));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`🛵 Arriving in ~${etaText} min`));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`💰 ${total}  🎫 ${shortTicket} (ticket 01-001661-99-102746)`));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  // Items — match screenshot indent: "1x Turkey and Provolone — $9.75" + "└ Mini"
  const itemLines = [];
  for (const item of cart) {
    const qty = item.quantity || 1;
    const name = item.name || item.id || 'Item';
    const size = item.selected_size || item.size || '';
    // Try to get price from result pricing if available
    let price = item.price;
    if (!price && result.pricing?.raw?.Order?.Products) {
      const prod = result.pricing.raw.Order.Products.find(p => (p.Name||'').toLowerCase().includes(name.toLowerCase().slice(0,6)));
      if (prod) price = prod.Price;
    }
    if (!price) {
      // fallback estimates
      const fallback = { 'dominos': 14.99, 'papajohns': 12.99, 'wingstop': 13.99 };
      price = fallback[store] || 9.99;
    }
    const priceStr = `$${Number(price).toFixed(2)}`;
    itemLines.push(`${qty}x ${name} — ${priceStr}`);
    if (size && size.toLowerCase() !== 'regular') itemLines.push(`└ ${size}`);
    else if (item.customizations && item.customizations.length) itemLines.push(`└ ${item.customizations.join(', ')}`);
    else itemLines.push(`└ Regular`);
  }
  if (itemLines.length === 0) itemLines.push(`1x Item — ${total}`);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(itemLines.join('\n')));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  const methodIcon = method === 'pickup' ? '🛍️' : '📍';
  const methodLabel = method === 'pickup' ? 'Pickup at:' : 'Delivering to:';
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${methodIcon} **${methodLabel}** ${addressRaw}`));
  const trackUrl = result.checkout_url || 'https://www.dominos.com/en/pages/order/#!/section/store/' + storeId + '/';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('🔗 Track Your Order').setURL(trackUrl)
  );
  container.addActionRowComponents(row);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Tap Track Your Order for live updates. This link stays current.`));
  return container;
}

function findSuccessfulCheckoutsChannel(guild) {
  if (!guild) return null;
  // prefer configured ID
  if (SUCCESSFUL_CHECKOUTS_CHANNEL_ID) {
    const byId = guild.channels.cache.get(SUCCESSFUL_CHECKOUTS_CHANNEL_ID);
    if (byId) return byId;
  }
  // exact + fuzzy match for "successful checkouts" / "successful-checkouts" / "successful_checkouts"
  for (const c of guild.channels.cache.values()) {
    if (c.type !== ChannelType.GuildText) continue;
    const n = c.name.toLowerCase();
    if (n === 'successful-checkouts' || n === 'successful_checkouts' || n === 'successful checkouts') return c;
    if (/successful.*checkouts/i.test(n)) return c;
  }
  return null;
}

function getStoreThumb(store) {
  const s = (store || '').toLowerCase();
  if (s.includes('five guys')) return 'https://images.unsplash.com/photo-1568909344668-6f14a07b56a0?w=400&h=400&fit=crop'; // burger
  if (s.includes('applebee')) return 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=400&h=400&fit=crop'; // restaurant grill
  if (s.includes('wingstop') || s.includes('wing')) return 'https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=400&h=400&fit=crop'; // wings
  if (s.includes('domino') || s.includes('pizza')) return 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400&h=400&fit=crop'; // pizza
  if (s.includes('panda') || s.includes('chinese')) return 'https://images.unsplash.com/photo-1555126634-323283e090fa?w=400&h=400&fit=crop';
  if (s.includes('taco') || s.includes('chipotle') || s.includes('qdoba')) return 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400&h=400&fit=crop';
  if (s.includes('chick-fil') || s.includes('popeyes') || s.includes('kfc')) return 'https://images.unsplash.com/photo-1550547660-d9450f859349?w=400&h=400&fit=crop';
  return 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=400&h=400&fit=crop'; // generic feast
}
function buildSuccessfulCheckoutContainer({ store, customerId, chefId, customerTotalStr, beforeDiscountStr, savingsStr, promo, orderId }) {
  const thumb = getStoreThumb(store);
  const container = new ContainerBuilder().setAccentColor(0x2ECC71);
  const timeStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const dateLine = `${orderId} • Today at ${timeStr}`;
  // Header with vibrant success + store-relevant thumbnail
  const headerSection = new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ✅ Checkout Successful 🎉\n-# Order completed • customer paid **${customerTotalStr}** • saved **${savingsStr}**`)
    )
    .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb).setDescription(store));
  container.addSectionComponents(headerSection);
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
  // Row 1
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# 🏪 Store  •  👤 Customer  •  💰 Total`));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${store}   <@${customerId}>   \`${customerTotalStr}\``));
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false));
  // Row 2
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# 👨‍🍳 Chef  •  🏷️ Promo Used  •  💳 Before Discount`));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`<@${chefId}>  \`${promo}\`  ~~${beforeDiscountStr}~~ → **${customerTotalStr}**`));
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false));
  // Row 3 - highlighted savings
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# 💵 Customer Total  •  ✨ Total Savings`));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${customerTotalStr}    🎉 ${savingsStr} saved`));
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ✅ Verified by Munchies • ${dateLine}`));
  return container;
}

function buildPanel() {
  const container = new ContainerBuilder().setAccentColor(0xFF8C00);
  const header = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# MUNCHIES · ORDER SERVICE\n## 🍔 Munchies Orders`))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL('attachment://panel.gif').setDescription('Munchies'));
  container.addSectionComponents(header);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`Select your deal below to open a **private ticket** with our chefs. Your ticket will be between you and staff only.`));
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
  const platformOptions = [];
  if (platforms['10for30']) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**🥬 10 FOR 30 DEALS**\nBest value bundle — 10 items for $30`));
    platformOptions.push({ label: '10 FOR 30 DEALS 🥬', value: 'deal_10for30', description: 'Open ticket for 10 for 30 deal', emoji: '🥬' });
  }
  if (platforms['doordash']) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**🚗 DOORDASH**\nGroup order discount — share your group link`));
    platformOptions.push({ label: 'DOORDASH 🚗', value: 'deal_doordash', description: 'Open ticket for DOORDASH', emoji: '🚗' });
  }
  if (platforms['ubereats']) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**🛵 Uber Eats**\nFood delivery — Uber Eats orders`));
    platformOptions.push({ label: 'Uber Eats 🛵', value: 'deal_ubereats', description: 'Open ticket for Uber Eats', emoji: '🛵' });
  }
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket_select')
    .setPlaceholder(platformOptions.length === 0 ? '❌ No platforms open right now' : '🛒 Choose your deal...')
    .setDisabled(platformOptions.length === 0);
  if (platformOptions.length > 0) menu.addOptions(platformOptions);
  const row = new ActionRowBuilder().addComponents(menu);
  container.addActionRowComponents(row);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# 📍 Select a deal to get started • Tickets are private`));
  return { components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2 };
}
async function getPanelGifAttachment() {
  try {
    const url = 'https://media1.tenor.com/m/dGU8KIYkB3wAAAAC/pizza-anime.gif';
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return new AttachmentBuilder(buf, { name: 'panel.gif' });
  } catch { return null; }
}

function buildFaqContainer() {
  const container = new ContainerBuilder().setAccentColor(0xFFA500);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🍔 How To Order`));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `**10 for 30 Deals**\n` +
    `• Use \`/deals\` to view available restaurants\n` +
    `• Pick a restaurant and make your order\n` +
    `• Send a screenshot of your *final checkout total*\n` +
    `• We’ll calculate your price\n` +
    `• Pay, and we’ll place the order`
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## 🥬 UE (50% OFF)\n` +
    `• Create an Uber Eats Group Order\n` +
    `• Add your items to the group order\n` +
    `• Send the group invite link in this ticket\n` +
    `• Send a screenshot showing your *subtotal*\n` +
    `• We’ll calculate your price, then place the order after payment`
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## 🚗 DoorDash\n` +
    `• Create a DoorDash Group Order\n` +
    `• Add your items to the group order\n` +
    `• Send the group invite link in this ticket\n` +
    `• Send a screenshot showing your *subtotal*\n` +
    `• We’ll calculate your price, then place the order after payment`
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## ✅ What You Get\n` +
    `• Live order tracking\n` +
    `• Fast delivery\n` +
    `• Transparent pricing`
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## 💳 Payments\n` +
    `PayPal • Cash App • Venmo • Apple Pay • Crypto • Zelle • Chime • Roblox Items`
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `## ⚠️ Rules\n` +
    `• Fake payment screenshots = instant ban\n` +
    `• Personal information is deleted after your order is completed.\n` +
    `• If your order is CANCELLED or DELIVERED and you cannot find it, we are unable to give u a refund or a reorder.`
  ));
  return { components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2 };
}

// === SLASH COMMAND REGISTRATION ===
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Send the food ticket panel (Admin only)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this ticket')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim this ticket (Chef only)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('unclaim')
    .setDescription('Unclaim this ticket (Chef only)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('open')
    .setDescription('Open restaurant - allow tickets and set status to 🟢-status')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('closed')
    .setDescription('Close restaurant - block tickets and set status to 🔴-status')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('deals')
    .setDescription('Show available restaurants')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('place')
    .setDescription('Place order - choose store, delivery/pickup, and address')
    .addStringOption(o => o.setName('store').setDescription('Store').setRequired(true).addChoices(
      { name: 'Dominos', value: 'dominos' },
      { name: 'Papa Johns', value: 'papajohns' },
      { name: 'Wingstop', value: 'wingstop' },
      { name: 'Panda Express', value: 'pandaexpress' },
      { name: 'Dairy Queen', value: 'dairyqueen' },
      { name: 'Five Guys', value: 'fiveguys' },
      { name: 'Zaxbys', value: 'zaxbys' },
      { name: 'Raising Canes', value: 'raisingcanes' },
      { name: 'Buffalo Wild Wings', value: 'bww' },
      { name: "Dave's Hot Chicken", value: 'daves' },
      { name: 'Chick-fil-A', value: 'chickfila' },
      { name: 'Shake Shack', value: 'shakeshack' },
    ))
    .addStringOption(o => o.setName('method').setDescription('Delivery or Pickup').setRequired(true).addChoices(
      { name: 'Delivery', value: 'delivery' },
      { name: 'Pickup', value: 'pickup' }
    ))
    .addStringOption(o => o.setName('address').setDescription('Delivery address: Street, City, ST ZIP (use pickup store address for pickup)').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('clockin')
    .setDescription('Clock in - start receiving ticket pings (Chef only)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('clockout')
    .setDescription('Clock out - stop receiving ticket pings (Chef only)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('faq')
    .setDescription('Show How To Order FAQ (Admin only)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('chefs')
    .setDescription('How to use the bot for chefs and admins')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('complete')
    .setDescription('Mark order complete - adds $2 to balance (Chef only)')
    .addStringOption(o => o.setName('store').setDescription('Store name (e.g. Applebees)').setRequired(true))
    .addStringOption(o => o.setName('total').setDescription('Customer total after discount (e.g. 8.80 or $8.80)').setRequired(true))
    .addStringOption(o => o.setName('before').setDescription('Before discount total (e.g. 22.00) - auto-calculated if empty').setRequired(false))
    .addStringOption(o => o.setName('promo').setDescription('Promo used (default: Munchies 60% off)').setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('bal')
    .setDescription('Check chef balance')
    .addUserOption(o => o.setName('chef').setDescription('Chef to check (Admin only)').setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('chefinfo')
    .setDescription('Show chef statistics including stars/rating')
    .addUserOption(o => o.setName('chef').setDescription('Chef to view (defaults to yourself)').setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('paid')
    .setDescription('Mark chef as paid (Crown role only) - /paid @user <amount>')
    .addUserOption(o => o.setName('user').setDescription('Chef to pay').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('How much you paid').setRequired(true).setMinValue(0.01))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('addbal')
    .setDescription('Add balance to a chef (Admin only)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addUserOption(o => o.setName('chef').setDescription('Chef to add to').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('Amount to add').setRequired(true).setMinValue(0.01))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('addorder')
    .setDescription('Add orders to today (Crown/Admin only)')
    .addUserOption(o => o.setName('chef').setDescription('Chef').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Orders to add').setRequired(true).setMinValue(1).setMaxValue(100))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('today')
    .setDescription('Show orders completed today')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('vouch')
    .setDescription('Vouch with a photo - earn 10 points')
    .addAttachmentOption(o => o.setName('photo').setDescription('Upload your vouch photo').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('platforms')
    .setDescription('Toggle which platforms are open on the order panel (Admin only)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .toJSON(),
];

async function registerCommands(guilds) {
  if (!CLIENT_ID) {
    console.log('[!] Skipping command register - set CLIENT_ID in .env');
    return;
  }
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  // Register for configured guild + every guild bot is in (fixes switch to new server + Missing Access)
  const targets = new Set();
  if (GUILD_ID) targets.add(GUILD_ID);
  if (guilds) for (const gid of guilds.keys()) targets.add(gid);
  console.log(`[i] Guilds bot is in: ${[...(guilds?.keys()||[])].join(', ') || 'none'} | will register for: ${[...targets].join(', ')}`);
  if (targets.length === 0) {
    console.log('[!] No guilds to register commands for');
    return;
  }
  for (const gid of targets) {
    try {
      console.log(`[i] Registering slash commands for guild ${gid}...`);
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gid), { body: commands });
      console.log(`[✔] Slash commands registered for ${gid}`);
    } catch (err) {
      console.error(`[X] Command register failed for ${gid}:`, err.message);
    }
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`[✔] Logged in as ${client.user.tag} in ${client.guilds.cache.size} guild(s)`);
  console.log(`[i] Chef Role ID: ${CHEF_ROLE_ID} (or higher)`);
  if (TICKET_CATEGORY_ID) console.log(`[i] Ticket Category: ${TICKET_CATEGORY_ID}`);
  if (CLAIMED_CATEGORY_ID) console.log(`[i] Claimed Category: ${CLAIMED_CATEGORY_ID}`);
  console.log(`[i] Status Channel: ${STATUS_CHANNEL_ID} - currently ${isOpen ? '🟢 OPEN' : '🔴 CLOSED'}`);
  // Load persisted data from Postgres if available (Railway)
  await dbInit();
  if (pool) {
    try {
      const s = await dbGet('status', null);
      if (s) { isOpen = s.open; statusGifMessageId = s.gifMessageId; }
      const c = await dbGet('clock', null);
      if (c?.clockedIn) { clockedIn.clear(); c.clockedIn.forEach(id=>clockedIn.add(id)); }
      const b = await dbGet('chef_balances', null);
      if (b) chefBalances = b;
      const d = await dbGet('daily_orders', null);
      if (d) dailyData = d;
      const v = await dbGet('vouch_points', null);
      if (v) vouchPoints = v;
      const cl = await dbGet('claimed', null);
      if (cl) { claimedTickets.clear(); for (const [k,vv] of Object.entries(cl)) claimedTickets.set(k,vv); }
      const pl = await dbGet('platforms', null);
      if (pl && typeof pl === 'object') {
        for (const key of ['10for30', 'doordash', 'ubereats']) {
          if (typeof pl[key] === 'boolean') platforms[key] = pl[key];
        }
      }
      const cr = await dbGet('chef_ratings', null);
      if (cr && typeof cr === 'object') chefRatings = cr;
      console.log(`[DB] loaded balances=${Object.keys(chefBalances).length} daily=${Object.keys(dailyData).length} claimed=${claimedTickets.size} ratings=${Object.keys(chefRatings).length}`);
    } catch(e){ console.log('[DB] load fail', e.message); }
  }
  await loadFromDiscord().catch(()=>{});
  console.log(`[DATA] after Discord load balances=${Object.keys(chefBalances).length} totalOrders=${Object.values(chefBalances).reduce((a,b)=>a+(b.totalOrders||0),0)}`);

  console.log(`[i] Clocked in chefs: ${clockedIn.size} ${[...clockedIn].join(', ') || '(none)'}`);
  await registerCommands(client.guilds.cache);
  await updateStatusChannel(isOpen);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // === SELECT MENU: show form modal (blocked when closed) ===
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_select') {
      if (!isOpen) {
        await interaction.reply({ content: '❌ The restaurant is currently closed. Please wait until we open!', ephemeral: true });
        return;
      }
      const choice = interaction.values[0];
      const normalized = choice === 'deal_redapp' ? 'deal_doordash' : choice;
      const modal = buildOrderModal(normalized);
      await interaction.showModal(modal);
      return;
    }

    // === BUTTON: platform toggle (admin panel) ===
    if (interaction.isButton() && (interaction.customId === 'toggle_10for30' || interaction.customId === 'toggle_doordash' || interaction.customId === 'toggle_ubereats')) {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await interaction.reply({ content: '❌ Admins only.', ephemeral: true });
        return;
      }
      const key = interaction.customId.replace('toggle_', '');
      platforms[key] = !platforms[key];
      savePlatforms();
      const statusLine = (name, k) => `${platforms[k] ? '🟢' : '🔴'} **${name}** — ${platforms[k] ? 'OPEN' : 'CLOSED'}`;
      const container = new ContainerBuilder().setAccentColor(0xFF8C00);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent('## ⚙️ Platform Manager\nToggle which platforms appear on the **order panel** for customers.'));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `${statusLine('10 FOR 30 DEALS', '10for30')}\n${statusLine('DOORDASH', 'doordash')}\n${statusLine('Uber Eats', 'ubereats')}`
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent('Click a button below to **toggle** a platform on/off:'));
      const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('toggle_10for30').setLabel('10 FOR 30').setStyle(platforms['10for30'] ? ButtonStyle.Success : ButtonStyle.Danger).setEmoji('🥬'),
        new ButtonBuilder().setCustomId('toggle_doordash').setLabel('DOORDASH').setStyle(platforms['doordash'] ? ButtonStyle.Success : ButtonStyle.Danger).setEmoji('🚗'),
        new ButtonBuilder().setCustomId('toggle_ubereats').setLabel('UBER EATS').setStyle(platforms['ubereats'] ? ButtonStyle.Success : ButtonStyle.Danger).setEmoji('🛵'),
      );
      container.addActionRowComponents(btnRow);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Green = open • Red = closed • Changes are instant`));
      await interaction.update({ components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2 });
      return;
    }

    // === MODAL SUBMIT: create ticket with form data (blocked when closed) ===
    if (interaction.isModalSubmit() && (interaction.customId === 'order_10for30' || interaction.customId === 'order_doordash' || interaction.customId === 'order_ubereats')) {
      if (!isOpen) {
        await interaction.reply({ content: '❌ The restaurant is currently closed. Please wait until we open!', ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      let dealValue = 'deal_10for30';
      if (interaction.customId === 'order_doordash') dealValue = 'deal_doordash';
      if (interaction.customId === 'order_ubereats') dealValue = 'deal_ubereats';
      const orderData = {
        address: interaction.fields.getTextInputValue('address')?.trim() || null,
        total: interaction.fields.getTextInputValue('total')?.trim() || null,
        payment: interaction.fields.getTextInputValue('payment')?.trim() || null,
        store: null,
        grouplink: null
      };
      if (interaction.customId === 'order_10for30' || interaction.customId === 'order_ubereats') {
        try { orderData.store = interaction.fields.getTextInputValue('store')?.trim() || null; } catch {}
      } else {
        try { orderData.grouplink = interaction.fields.getTextInputValue('grouplink')?.trim() || null; } catch {}
      }

      const result = await createTicket(interaction.guild, interaction.user, dealValue, orderData);

      if (result.alreadyExists) {
        await interaction.editReply({ content: `⚠️ You already have an open ticket: <#${result.channel.id}>` });
        return;
      }

      const deal = getDealInfo(dealValue);
      await interaction.editReply({ content: `✅ Ticket created: <#${result.channel.id}> - **${deal.label}**` });
      return;
    }

    // === BUTTON: Claim ===
    if (interaction.isButton() && interaction.customId === 'claim_ticket') {
      const guild = interaction.guild;
      const member = interaction.member;

      if (!hasChefPermission(member, guild)) {
        await interaction.reply({ content: '❌ Only <@&' + CHEF_ROLE_ID + '> or higher can claim tickets.', ephemeral: true });
        return;
      }

      const channelId = interaction.channelId;
      if (claimedTickets.has(channelId)) {
        const claimedBy = claimedTickets.get(channelId);
        if (interaction.channel.parentId === TICKET_CATEGORY_ID) {
          claimedTickets.delete(channelId);
      saveClaimed();
        } else {
          await interaction.reply({ content: `⚠️ Already claimed by <@${claimedBy}>`, ephemeral: true });
          return;
        }
      }

      const isExempt = interaction.member.roles.cache.has(PAID_ROLE_ID) || (interaction.guild.roles.cache.get(PAID_ROLE_ID) && interaction.member.roles.highest.position >= interaction.guild.roles.cache.get(PAID_ROLE_ID).position);
      const curClaimed = countClaimedBy(interaction.user.id);
      if (!isExempt && curClaimed >= 3) {
        await interaction.reply({ content: `❌ You have \`${curClaimed}/3\` tickets claimed. Do \`/complete\` or \`/unclaim\` to free a slot.`, ephemeral: true });
        return;
      }

      claimedTickets.set(channelId, interaction.user.id);
      saveClaimed();

      // V2 claimed reply
      const claimedContainer = new ContainerBuilder().setAccentColor(0x2ECC71)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`✅ **Claimed by <@${interaction.user.id}>** — this ticket is now locked 1:1`));
      await interaction.reply({ components: [claimedContainer], flags: MessageFlagsBitField.Flags.IsComponentsV2 });

      // Edit original ticket message to V2 claimed state (disable claim)
      try {
        const stored = ticketStore.get(channelId);
        if (stored) {
          const updated = buildTicketContainer(stored.deal, stored.orderData, stored.user, interaction.user.id);
          await interaction.message.edit({ components: [updated], flags: MessageFlagsBitField.Flags.IsComponentsV2 }).catch(()=>{});
        } else {
          const fallback = new ContainerBuilder().setAccentColor(0x2ECC71)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`✅ Claimed by <@${interaction.user.id}>`));
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('unclaim_ticket').setLabel('Unclaim').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
            new ButtonBuilder().setCustomId('close_ticket').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒')
          );
          fallback.addActionRowComponents(row);
          await interaction.message.edit({ components: [fallback], flags: MessageFlagsBitField.Flags.IsComponentsV2 }).catch(()=>{});
        }
      } catch {}

      // 1-on-1 lock + move to Claimed category + rename
      try {
        if (CLAIMED_CATEGORY_ID) {
          await interaction.channel.setParent(CLAIMED_CATEGORY_ID, { lockPermissions: false }).catch(() => {});
        }
        const newName = `claimed-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`.slice(0, 90);
        await interaction.channel.setName(newName).catch(() => {});
      } catch {}

      // Lock channel: deny CHEF role, allow only claimer + customer
      try {
        const topic = interaction.channel.topic || '';
        const m = topic.match(/\b\d{17,20}\b/);
        const customerId = m ? m[0] : null;

        // Lock for other chefs: keep View but deny SendMessages - claimer gets explicit allow that overrides this
        await interaction.channel.permissionOverwrites.edit(CHEF_ROLE_ID, {
          ViewChannel: true,
          SendMessages: false
        }).catch(()=>{});

        // Explicit allow for claimer (overrides the chef role deny)
        await interaction.channel.permissionOverwrites.edit(interaction.user.id, {
          ViewChannel: true, SendMessages: true, ReadMessageHistory: true
        }).catch(()=>{});

        // Ensure customer still has access
        if (customerId) {
          await interaction.channel.permissionOverwrites.edit(customerId, {
            ViewChannel: true, SendMessages: true, ReadMessageHistory: true
          }).catch(()=>{});
        }
      } catch {}

      console.log(`[✔] Ticket ${interaction.channel.name} claimed by ${interaction.user.tag} - locked to 1:1 (read-only for other chefs) and moved to ${CLAIMED_CATEGORY_ID}`);
      return;
    }

    // === BUTTON: Unclaim ===
    if (interaction.isButton() && interaction.customId === 'unclaim_ticket') {
      if (!hasChefPermission(interaction.member, interaction.guild)) {
        await interaction.reply({ content: '❌ Only <@&' + CHEF_ROLE_ID + '> or higher can unclaim.', ephemeral: true });
        return;
      }
      const channelId = interaction.channelId;
      let claimedBy = claimedTickets.get(channelId);
      let inferred = false;
      if (!claimedBy) {
        // Fallback: ticket looks claimed (in Claimed category or has chef lock) but Map lost after restart
        const isInClaimedCat = CLAIMED_CATEGORY_ID && interaction.channel.parentId === CLAIMED_CATEGORY_ID;
        let inferredClaimer = null;
        try {
          const topic = interaction.channel.topic || '';
          const m = topic.match(/\b\d{17,20}\b/);
          const customerId = m ? m[0] : null;
          for (const [id, ow] of interaction.channel.permissionOverwrites.cache) {
            if (ow.type !== 1) continue; // member overwrite only
            if (id === client.user.id) continue;
            if (customerId && id === customerId) continue;
            if (ow.allow.has(PermissionsBitField.Flags.ViewChannel) && ow.allow.has(PermissionsBitField.Flags.SendMessages)) {
              inferredClaimer = id;
              break;
            }
          }
        } catch {}
        if (isInClaimedCat || inferredClaimer) {
          claimedBy = inferredClaimer || interaction.user.id; // allow force unclaim
          inferred = true;
          if (inferredClaimer) claimedTickets.set(channelId, inferredClaimer);
          console.log(`[↩️] unclaim fallback: isInClaimed=${isInClaimedCat} inferred=${inferredClaimer} force by ${interaction.user.tag}`);
        } else {
          await interaction.reply({ content: '⚠️ Ticket is not claimed.', ephemeral: true });
          return;
        }
      }
      // Only claimer or Admin can unclaim (skip strict check for inferred fallback)
      const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
      if (!inferred && interaction.user.id !== claimedBy && !isAdmin) {
        await interaction.reply({ content: `❌ Only <@${claimedBy}> or an Admin can unclaim this.`, ephemeral: true });
        return;
      }
      claimedTickets.delete(channelId);
      saveClaimed();
      const unclaimContainer = new ContainerBuilder().setAccentColor(0xF39C12)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`↩️ **Unclaimed by <@${interaction.user.id}>** — ticket is now open for any chef.`));
      await interaction.reply({ components: [unclaimContainer], flags: MessageFlagsBitField.Flags.IsComponentsV2 });
      // Rebuild ticket as unclaimed
      try {
        const stored = ticketStore.get(channelId);
        if (stored) {
          const updated = buildTicketContainer(stored.deal, stored.orderData, stored.user, null);
          await interaction.message.edit({ components: [updated], flags: MessageFlagsBitField.Flags.IsComponentsV2 }).catch(()=>{});
        }
      } catch {}
      // Move back to Tickets category and rename
      try {
        if (TICKET_CATEGORY_ID) await interaction.channel.setParent(TICKET_CATEGORY_ID, { lockPermissions: false }).catch(()=>{});
        const stored = ticketStore.get(channelId);
        const dealShort = stored?.deal?.short || 'deal';
        const customerTag = stored?.user?.username || 'customer';
        const newName = `ticket-${customerTag.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${dealShort}`.slice(0, 90);
        await interaction.channel.setName(newName).catch(()=>{});
      } catch {}
      // Restore permissions for all chefs - clear claimer overwrite(s)
      try {
        await interaction.channel.permissionOverwrites.edit(CHEF_ROLE_ID, { ViewChannel: true, SendMessages: true }).catch(()=>{});
        if (claimedBy && claimedBy !== 'unknown') await interaction.channel.permissionOverwrites.delete(claimedBy).catch(()=>{});
        // also clear any leftover chef user overwrites (force cleanup for inferred case)
        const topic2 = interaction.channel.topic || '';
        const m2 = topic2.match(/\b\d{17,20}\b/);
        const custId2 = m2 ? m2[0] : null;
        for (const [id, ow] of interaction.channel.permissionOverwrites.cache) {
          if (ow.type !== 1) continue;
          if (id === client.user.id) continue;
          if (custId2 && id === custId2) continue;
          if (id === claimedBy) continue;
          // delete any other user-specific allow
          if (ow.allow.has(PermissionsBitField.Flags.ViewChannel)) {
            await interaction.channel.permissionOverwrites.delete(id).catch(()=>{});
          }
        }
      } catch {}
      // Resend fresh claim prompt so chefs can press Claim again
      try {
        const stored = ticketStore.get(channelId);
        if (stored) {
          const fresh = buildTicketContainer(stored.deal, stored.orderData, stored.user, null);
          const pingIds = [...clockedIn];
          const u = [...new Set([stored.user.id, ...pingIds])];
          const gifAtt2b = await getTicketGifAttachment(stored.deal.short);
          const files2b = gifAtt2b ? [gifAtt2b] : [];
          await interaction.channel.send({ components: [fresh], flags: MessageFlagsBitField.Flags.IsComponentsV2, files: files2b, allowedMentions: { users: u } }).catch(()=>{});
        }
      } catch {}
      console.log(`[↩️] Ticket ${interaction.channel.name} unclaimed by ${interaction.user.tag}`);
      return;
    }

    // === BUTTON: Close ===
    if (interaction.isButton() && interaction.customId === 'close_ticket') {
      await interaction.reply({ content: '🔒 Closing ticket in 3 seconds...' });
      claimedTickets.delete(interaction.channelId);
      saveClaimed();
      setTimeout(async () => {
        await interaction.channel.delete().catch(() => interaction.channel.send('❌ No permission to delete channel.').catch(() => {}));
      }, 3000);
      return;
    }

    // === SLASH: /panel ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await interaction.reply({ content: '❌ Only **Admins** can use `/panel`.', ephemeral: true });
        return;
      }
      const panel = buildPanel();
      const targetChannel = interaction.channel;
      const gifAtt = await getPanelGifAttachment();
      const files = gifAtt ? [gifAtt] : [];
      await targetChannel.send({ ...panel, files });
      await interaction.reply({ content: `✅ Panel sent in <#${targetChannel.id}>`, ephemeral: true });
      return;
    }

    // === SLASH: /platforms (Admin toggle panel platforms) ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'platforms') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await interaction.reply({ content: '❌ Only **Admins** can use `/platforms`.', ephemeral: true });
        return;
      }
      const container = new ContainerBuilder().setAccentColor(0xFF8C00);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent('## ⚙️ Platform Manager\nToggle which platforms appear on the **order panel** for customers.'));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      const statusLine = (name, key) => {
        const on = platforms[key];
        return `${on ? '🟢' : '🔴'} **${name}** — ${on ? 'OPEN' : 'CLOSED'}`;
      };
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `${statusLine('10 FOR 30 DEALS', '10for30')}\n${statusLine('DOORDASH', 'doordash')}\n${statusLine('Uber Eats', 'ubereats')}`
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent('Click a button below to **toggle** a platform on/off:'));
      const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('toggle_10for30').setLabel('10 FOR 30').setStyle(platforms['10for30'] ? ButtonStyle.Success : ButtonStyle.Danger).setEmoji('🥬'),
        new ButtonBuilder().setCustomId('toggle_doordash').setLabel('DOORDASH').setStyle(platforms['doordash'] ? ButtonStyle.Success : ButtonStyle.Danger).setEmoji('🚗'),
        new ButtonBuilder().setCustomId('toggle_ubereats').setLabel('UBER EATS').setStyle(platforms['ubereats'] ? ButtonStyle.Success : ButtonStyle.Danger).setEmoji('🛵'),
      );
      container.addActionRowComponents(btnRow);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Green = open • Red = closed • Changes are instant`));
      await interaction.reply({ components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2, ephemeral: true });
      return;
    }

     // === SLASH: /deals ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'deals') {
      const dealsText = `**Available Restaurants**
▸  Domino's
▸  Papa John's
▸  Church's Chicken
▸  Jersey Mike's Subs
▸  Panda Express
▸  Auntie Anne's
▸  Panera Bread
▸  IHOP  ·  not for everyone
▸  Smoothie King  ·  sometimes
▸  Applebee's
▸  Tropical Smoothie Cafe
▸  Sonic
▸  Buffalo Wild Wings
▸  Marco's Pizza
▸  Jim N Nick's Bar-B-Q
▸  CAVA
▸  Fluffies Hot Chicken
▸  Steak 'n Shake
▸  Taco Cabana
▸  Raising Cane's Chicken Fingers  ·  pickup only
▸  McAlister's Deli
▸  Carl's Jr.
▸  Whataburger
▸  Zaxby's
▸  Red Lobster
▸  P.F. Chang's
▸  Jamba
▸  Playa Bowls
▸  Five Guys
▸  The Habit Burger Grill
▸  Smashburger
▸  Insomnia Cookies
▸  Qdoba
▸  Jollibee
▸  Wingstop`;

      const dealsContainer = new ContainerBuilder().setAccentColor(0x2ECC71)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(dealsText));
      await interaction.reply({ components: [dealsContainer], flags: MessageFlagsBitField.Flags.IsComponentsV2 });
      return;
    }

    // === SLASH: /place (store + delivery/pickup + address) ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'place') {
      try { await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral }); } catch(e){ console.log('[place] defer fail', e.message); }
      const store = interaction.options.getString('store');
      const method = interaction.options.getString('method'); // delivery or pickup
      const addressRaw = interaction.options.getString('address');
      // Parse address like /checkout
      let address = {};
      try {
        if (addressRaw.includes('|')) {
          const parts = addressRaw.split('|').map(s=>s.trim());
          address = { street: parts[0]||'', city: parts[1]||'', state: parts[2]||'', zip: parts[3]||'' };
        } else {
          const m = addressRaw.match(/^(.*?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/i);
          if (m) address = { street: m[1].trim(), city: m[2].trim(), state: m[3].trim().toUpperCase(), zip: m[4].trim() };
          else address = { street: addressRaw, city: '', state: '', zip: '' };
        }
      } catch(e){ address = { street: addressRaw, city: '', state: '', zip: '' }; }
      // Default cart per store (same as /checkout)
      let cart = [];
      if (store === 'dominos') cart = [{ id: 'dominos-build-your-pizza', name: 'Build Your Pizza', selected_size: 'Large', quantity: 1, customizations: ['Pepperoni'] }];
      else if (store === 'papajohns') cart = [{ id: 'pj-pepperoni', name: 'Pepperoni Pizza', selected_size: 'Large', quantity: 1, customizations: [] }];
      else if (store === 'wingstop') cart = [{ id: 'ws-classic-wings', name: 'Classic Wings', selected_size: '10 Piece', quantity: 1, customizations: ['Garlic Parmesan'] }];
      else cart = [{ id: `${store}-item`, name: `${store} Item`, selected_size: 'Regular', quantity: 1, customizations: [] }];
      const orderData = { address, cart, contact: {}, payment: {}, delivery_type: method, store };
      const py2 = process.env.PYTHON || 'python';
      const proc2 = spawn(py2, ['-m', 'stores.service', store, JSON.stringify(orderData)], { cwd: __dirname });
      let out2 = ''; let err2 = '';
      proc2.stdout.on('data', d=> out2 += d.toString());
      proc2.stderr.on('data', d=> err2 += d.toString());
      const timeout2 = setTimeout(()=> { try{ proc2.kill(); }catch{} }, 40000);
      proc2.on('close', async code => {
        clearTimeout(timeout2);
        if (code !== 0) {
          await interaction.editReply({ content: `❌ /place failed (${store} ${method}) code ${code}:\n\`\`\`${(err2||out2).slice(0,1500)}\`\`\`` }).catch(()=>{});
          return;
        }
        try {
          let jsonStr2 = out2;
          const idx2 = out2.indexOf('{"success"') !== -1 ? out2.indexOf('{"success"') : out2.indexOf('{');
          if (idx2 > 0) jsonStr2 = out2.slice(idx2);
          if (jsonStr2.trim().startsWith('{') === false) {
            const fb = out2.indexOf('{\n');
            if (fb !== -1) jsonStr2 = out2.slice(fb);
          }
          const result = JSON.parse(jsonStr2);
          const confirmed = buildOrderConfirmedContainer(store, result, addressRaw, cart, method);
          await interaction.editReply({ components: [confirmed], flags: MessageFlagsBitField.Flags.IsComponentsV2 }).catch(()=>{});
        } catch(e) {
          console.log('[place] parse fail', e.message, 'out2:', out2.slice(0,800));
          await interaction.editReply({ content: `❌ Parse failed:\n\`\`\`${e.message}\`\`\`\nRaw:\n\`\`\`json\n${out2.slice(0,1500)}\n\`\`\`` }).catch(()=>{});
        }
      });
      return;
    }

    // === SLASH: /claim ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'claim') {
      if (!hasChefPermission(interaction.member, interaction.guild)) {
        await interaction.reply({ content: '❌ Only Chef+ can claim.', ephemeral: true });
        return;
      }
      if (claimedTickets.has(interaction.channelId)) {
        const cBy = claimedTickets.get(interaction.channelId);
        if (interaction.channel.parentId === TICKET_CATEGORY_ID) {
          claimedTickets.delete(interaction.channelId);
      saveClaimed();
        } else {
          await interaction.reply({ content: `⚠️ Already claimed by <@${cBy}>`, ephemeral: true });
          return;
        }
      }
      const isExempt2 = interaction.member.roles.cache.has(PAID_ROLE_ID) || (interaction.guild.roles.cache.get(PAID_ROLE_ID) && interaction.member.roles.highest.position >= interaction.guild.roles.cache.get(PAID_ROLE_ID).position);
      const curClaimed2 = countClaimedBy(interaction.user.id);
      if (!isExempt2 && curClaimed2 >= 3) {
        await interaction.reply({ content: `❌ You have \`${curClaimed2}/3\` tickets claimed. Do \`/complete\` or \`/unclaim\` to free a slot.`, ephemeral: true });
        return;
      }
      claimedTickets.set(interaction.channelId, interaction.user.id);
      const slashClaimContainer = new ContainerBuilder().setAccentColor(0x2ECC71)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`✅ **Claimed by <@${interaction.user.id}>** — locked to 1:1`));
      await interaction.reply({ components: [slashClaimContainer], flags: MessageFlagsBitField.Flags.IsComponentsV2 });
      try {
        if (CLAIMED_CATEGORY_ID) await interaction.channel.setParent(CLAIMED_CATEGORY_ID, { lockPermissions: false }).catch(()=>{});
        const newName = `claimed-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`.slice(0, 90);
        await interaction.channel.setName(newName).catch(()=>{});
        const topic = interaction.channel.topic || '';
        const m = topic.match(/\b\d{17,20}\b/);
        const customerId = m ? m[0] : null;
        await interaction.channel.permissionOverwrites.edit(CHEF_ROLE_ID, { ViewChannel: true, SendMessages: false }).catch(()=>{});
        await interaction.channel.permissionOverwrites.edit(interaction.user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(()=>{});
        if (customerId) await interaction.channel.permissionOverwrites.edit(customerId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(()=>{});
        // also update stored ticket container if possible
        const storedSlash = ticketStore.get(interaction.channelId);
        if (storedSlash) {
          const updatedSlash = buildTicketContainer(storedSlash.deal, storedSlash.orderData, storedSlash.user, interaction.user.id);
          // find original bot message in channel and edit it (best effort)
          const msgs = await interaction.channel.messages.fetch({ limit: 10 }).catch(()=>null);
          const botMsg = msgs?.find(m => m.author.id === client.user.id && m.components.length > 0);
          if (botMsg) await botMsg.edit({ components: [updatedSlash], flags: MessageFlagsBitField.Flags.IsComponentsV2 }).catch(()=>{});
        }
      } catch {}
      return;
    }

    // === SLASH: /unclaim ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'unclaim') {
      if (!hasChefPermission(interaction.member, interaction.guild)) {
        await interaction.reply({ content: '❌ Only Chef+ can unclaim.', ephemeral: true });
        return;
      }
      let claimedBy = claimedTickets.get(interaction.channelId);
      let inferredSlash = false;
      if (!claimedBy) {
        const isInClaimedCat2 = CLAIMED_CATEGORY_ID && interaction.channel.parentId === CLAIMED_CATEGORY_ID;
        let inferredClaimer2 = null;
        try {
          const topic = interaction.channel.topic || '';
          const m = topic.match(/\b\d{17,20}\b/);
          const customerId = m ? m[0] : null;
          for (const [id, ow] of interaction.channel.permissionOverwrites.cache) {
            if (ow.type !== 1) continue;
            if (id === client.user.id) continue;
            if (customerId && id === customerId) continue;
            if (ow.allow.has(PermissionsBitField.Flags.ViewChannel) && ow.allow.has(PermissionsBitField.Flags.SendMessages)) {
              inferredClaimer2 = id;
              break;
            }
          }
        } catch {}
        if (isInClaimedCat2 || inferredClaimer2) {
          claimedBy = inferredClaimer2 || interaction.user.id;
          inferredSlash = true;
          if (inferredClaimer2) claimedTickets.set(interaction.channelId, inferredClaimer2);
        } else {
          await interaction.reply({ content: '⚠️ This ticket is not claimed.', ephemeral: true });
          return;
        }
      }
      const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
      if (!inferredSlash && interaction.user.id !== claimedBy && !isAdmin) {
        await interaction.reply({ content: `❌ Only <@${claimedBy}> or an Admin can unclaim.`, ephemeral: true });
        return;
      }
      claimedTickets.delete(interaction.channelId);
      saveClaimed();
      const unclaimSlashContainer = new ContainerBuilder().setAccentColor(0xF39C12)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`↩️ **Unclaimed by <@${interaction.user.id}>** — now open`));
      await interaction.reply({ components: [unclaimSlashContainer], flags: MessageFlagsBitField.Flags.IsComponentsV2 });
      try {
        if (TICKET_CATEGORY_ID) await interaction.channel.setParent(TICKET_CATEGORY_ID, { lockPermissions: false }).catch(()=>{});
        const stored = ticketStore.get(interaction.channelId);
        const dealShort = stored?.deal?.short || 'deal';
        const customerTag = stored?.user?.username || 'customer';
        await interaction.channel.setName(`ticket-${customerTag.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${dealShort}`.slice(0, 90)).catch(()=>{});
        await interaction.channel.permissionOverwrites.edit(CHEF_ROLE_ID, { ViewChannel: true, SendMessages: true }).catch(()=>{});
        await interaction.channel.permissionOverwrites.delete(claimedBy).catch(()=>{});
        if (stored) {
          const updated = buildTicketContainer(stored.deal, stored.orderData, stored.user, null);
          const msgs = await interaction.channel.messages.fetch({ limit: 10 }).catch(()=>null);
          const botMsg = msgs?.find(m => m.author.id === client.user.id && m.components.length > 0);
          if (botMsg) await botMsg.edit({ components: [updated], flags: MessageFlagsBitField.Flags.IsComponentsV2 }).catch(()=>{});
          // Resend fresh claim prompt so chefs can press Claim again
          const fresh = buildTicketContainer(stored.deal, stored.orderData, stored.user, null);
          const pingIds2 = [...clockedIn];
          const u2 = [...new Set([stored.user.id, ...pingIds2])];
          const gifAtt3 = await getTicketGifAttachment(stored.deal.short);
          const files3 = gifAtt3 ? [gifAtt3] : [];
          await interaction.channel.send({ components: [fresh], flags: MessageFlagsBitField.Flags.IsComponentsV2, files: files3, allowedMentions: { users: u2 } }).catch(()=>{});
        }
      } catch {}
      console.log(`[↩️] Ticket ${interaction.channel.name} unclaimed via /unclaim by ${interaction.user.tag}`);
      return;
    }

    // === SLASH: /close ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'close') {
      await interaction.reply({ content: '🔒 Closing...' });
      claimedTickets.delete(interaction.channelId);
      saveClaimed();
      setTimeout(() => interaction.channel.delete().catch(()=>{}), 2000);
      return;
    }

    // === SLASH: /open ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'open') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && !hasChefPermission(interaction.member, interaction.guild)) {
        await interaction.reply({ content: '❌ You need Manage Server or Chef+ to do that.', ephemeral: true });
        return;
      }
      try { await interaction.reply({ content: 'Restaurant set to open' }); } catch(e){ console.log('[X] open reply', e.message); }
      updateStatusChannel(true).catch(e=> console.log('[X] open rename', e.message));
      updateStatusGif(true).catch(e=> console.log('[X] open gif', e.message));
      return;
    }

    // === SLASH: /closed ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'closed') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && !hasChefPermission(interaction.member, interaction.guild)) {
        await interaction.reply({ content: '❌ You need Manage Server or Chef+ to do that.', ephemeral: true });
        return;
      }
      try { await interaction.reply({ content: 'Restaurant set to closed' }); } catch(e){ console.log('[X] closed reply', e.message); }
      updateStatusChannel(false).catch(e=> console.log('[X] closed rename', e.message));
      updateStatusGif(false).catch(e=> console.log('[X] closed gif', e.message));
      return;
    }

    // === SLASH: /clockin ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'clockin') {
      if (!hasChefPermission(interaction.member, interaction.guild)) {
        await interaction.reply({ content: '❌ Only <@&' + CHEF_ROLE_ID + '> or higher can use this.', ephemeral: true });
        return;
      }
      if (clockedIn.has(interaction.user.id)) {
        await interaction.reply({ content: '✅ You are already clocked in! You will receive ticket pings.', ephemeral: true });
        return;
      }
      clockedIn.add(interaction.user.id);
      saveClock();
      await interaction.reply({ content: '✅ Clocked in! You will now receive ticket pings.', ephemeral: true });
      return;
    }

    // === SLASH: /clockout ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'clockout') {
      if (!hasChefPermission(interaction.member, interaction.guild)) {
        await interaction.reply({ content: '❌ Only <@&' + CHEF_ROLE_ID + '> or higher can use this.', ephemeral: true });
        return;
      }
      if (!clockedIn.has(interaction.user.id)) {
        await interaction.reply({ content: '⚠️ You are not clocked in.', ephemeral: true });
        return;
      }
      clockedIn.delete(interaction.user.id);
      saveClock();
      await interaction.reply({ content: '✅ Clocked out! You will no longer receive ticket pings.', ephemeral: true });
      return;
    }

    // === SLASH: /faq ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'faq') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await interaction.reply({ content: '❌ Only **Admins** can use `/faq`.', ephemeral: true });
        return;
      }
      const faq = buildFaqContainer();
      const targetChannel = interaction.channel;
      await targetChannel.send(faq);
      await interaction.reply({ content: `✅ FAQ sent in <#${targetChannel.id}>`, ephemeral: true });
      return;
    }

    // === SLASH: /chefs ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'chefs') {
      if (!hasChefPermission(interaction.member, interaction.guild) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await interaction.reply({ content: '❌ Only Chefs or Admins can use this.', ephemeral: true });
        return;
      }
      const container = new ContainerBuilder().setAccentColor(0x57F287);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 👨‍🍳 Chef & Admin Guide`));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`How to use Munchies bot — clock, status, tickets & orders`));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### 🕐 Clock In / Out\n` +
        `• \`/clockin\` — Clock in, start receiving ticket pings (<@&${CHEF_ROLE_ID}>)\n` +
        `• \`/clockout\` — Clock out, stop receiving pings\n` +
        `• Only clocked-in chefs get pinged`
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### 🟢 / 🔴 Open & Close\n` +
        `• \`/open\` — Set to **open**, allow tickets, rename to \`🟢-status\`\n` +
        `• \`/closed\` — Set to **closed**, block tickets\n` +
        `• Requires Chef+ or Manage Server`
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### 🎟️ Claim & Unclaim\n` +
        `• **Claim** or \`/claim\` — Claim ticket, locks 1:1, moves to \`Claimed\`\n` +
        `• **Unclaim** or \`/unclaim\` — Release it, back to \`Tickets\`\n` +
        `• 3 ticket limit — do \`/complete\` or \`/unclaim\` to free slot`
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### ✅ Complete & Balance **(DO THIS WHEN FINISHED)**\n` +
        `• \`/complete\` — **Mark order done** in ticket, adds **$2**, frees slot, sends *Order Completed* + *Rate your chef* (customer rates 1-5)\n` +
        `• \`/bal\` — Check your balance & total orders\n` +
        `• \`/paid @user <amount>\` — Crown <@&${PAID_ROLE_ID}> clears balance (e.g. \`/paid @chef 10\`)\n` +
        `• \`/today\` — Orders today, busiest hour, top chefs`
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### 🔧 Admin & Utils\n` +
        `• \`/panel\` / \`!panel\` — Post ticket panel (Admin only)\n` +
        `• \`/faq\` — How To Order (Admin only)\n` +
        `• \`/deals\` / \`/vouch <photo>\` — Restaurants / Vouch +10pts (anyone)\n` +
        `• \`/close\` — Close & delete ticket`
      ));
      await interaction.reply({ components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2 });
      return;
    }

    // === SLASH: /complete ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'complete') {
      if (!hasChefPermission(interaction.member, interaction.guild)) {
        await interaction.reply({ content: '❌ Only <@&' + CHEF_ROLE_ID + '> can use `/complete`.', ephemeral: true });
        return;
      }
      const chId = interaction.channelId;
      // No claim required - any chef can complete any ticket
      const wasClaimedBy = claimedTickets.get(chId);
      if (claimedTickets.has(chId)) claimedTickets.delete(chId);
      saveClaimed();
      // Get ticket data
      const stored = ticketStore.get(chId);
      let customerId = null;
      let customerTag = 'Customer';
      if (stored?.user) { customerId = stored.user.id; customerTag = stored.user.tag; }
      else {
        const m = interaction.channel.topic?.match(/\b\d{17,20}\b/);
        if (m) customerId = m[0];
      }
      const customerMention = customerId ? `<@${customerId}>` : '@Unknown';
      const chefMention = `<@${interaction.user.id}>`;
      // Update balance
      const bal = getChefBalance(interaction.user.id);
      bal.balance += 2;
      bal.totalOrders += 1;
      saveBalances();
      logOrderToday(interaction.user.id);
      // Free claim slot
      claimedTickets.delete(chId);
      saveClaimed();
      // Restore chef perms so they can claim again (keep channel open for rating)
      try { await interaction.channel.permissionOverwrites.edit(CHEF_ROLE_ID, { ViewChannel: true, SendMessages: true }).catch(()=>{}); } catch {}
      const totalOrders = bal.totalOrders;
      const newBal = bal.balance.toFixed(2);
      // Order Completed container (like screenshot)
      const completed = new ContainerBuilder().setAccentColor(0x57F287);
      completed.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ✅ Order Completed`));
      completed.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      completed.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `**Service:** Service\n` +
        `**Chef:** ${chefMention}\n` +
        `**Customer:** ${customerMention}\n` +
        `**Status:** Marked complete`
      ));
      completed.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      completed.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `**Chef Overview**\n` +
        `↳ **Total Orders:** \`${totalOrders} orders\`\n` +
        `↳ **Fee Earned:** \`$2.00\`\n` +
        `↳ **New Balance:** \`$${newBal}\``
      ));
      completed.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Completed by ${interaction.user.username}`));
      // Rating prompt container (like screenshot)
      const rating = new ContainerBuilder().setAccentColor(0xFFD700);
      const chefDisplay = interaction.user.username;
      rating.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ⭐ Rate your chef`));
      rating.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${customerMention}, how was your experience with **${chefDisplay}**?`));
      const rateRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('rate_1').setLabel('1').setStyle(ButtonStyle.Danger).setEmoji('⭐'),
        new ButtonBuilder().setCustomId('rate_2').setLabel('2').setStyle(ButtonStyle.Danger).setEmoji('⭐'),
        new ButtonBuilder().setCustomId('rate_3').setLabel('3').setStyle(ButtonStyle.Secondary).setEmoji('⭐'),
        new ButtonBuilder().setCustomId('rate_4').setLabel('4').setStyle(ButtonStyle.Primary).setEmoji('⭐'),
        new ButtonBuilder().setCustomId('rate_5').setLabel('5').setStyle(ButtonStyle.Success).setEmoji('⭐')
      );
      rating.addActionRowComponents(rateRow);
      await interaction.reply({ components: [completed], flags: MessageFlagsBitField.Flags.IsComponentsV2 });
      const ratingMsg = await interaction.channel.send({ components: [rating], flags: MessageFlagsBitField.Flags.IsComponentsV2 }).catch(()=>null);
      if (ratingMsg && customerId) ratingStore.set(ratingMsg.id, { customerId, chefId: interaction.user.id });
      // === SUCCESSFUL CHECKOUTS LOG ===
      try {
        let scChannel = findSuccessfulCheckoutsChannel(interaction.guild);
        if (!scChannel && SUCCESSFUL_CHECKOUTS_CHANNEL_ID) {
          try { scChannel = await interaction.guild.channels.fetch(SUCCESSFUL_CHECKOUTS_CHANNEL_ID); } catch {}
        }
        if (scChannel) {
          const s = ticketStore.get(chId);
          const od = s?.orderData || {};
          const dl = s?.deal || { label: 'Munchies', short: 'deal' };
          // Store / totals now come from /complete options (chef input) - fallback to ticket data
          const optStore = interaction.options.getString('store');
          const optTotal = interaction.options.getString('total');
          const optBefore = interaction.options.getString('before');
          const optPromo = interaction.options.getString('promo');
          let storeName = optStore ? optStore.trim() : null;
          if (!storeName) {
            storeName = (od.store && od.store.trim()) ? od.store.trim() : null;
            if (!storeName) {
              const cleanLabel = dl.label ? dl.label.replace(/[^\w\s&'-]/g,'').trim() : '';
              storeName = cleanLabel || "Munchies";
            }
          }
          // Totals
          let rawTotal = optTotal ? String(optTotal).trim() : ((od.total && String(od.total).trim()) ? String(od.total).trim() : '$8.80');
          if (!rawTotal.startsWith('$')) rawTotal = '$' + rawTotal.replace('$','');
          const ctNum = parseFloat(rawTotal.replace(/[^0-9.]/g,'')) || 8.80;
          const customerTotalStr = `$${ctNum.toFixed(2)}`;
          let beforeNum;
          if (optBefore && String(optBefore).trim()) {
            let rawBefore = String(optBefore).trim();
            if (!rawBefore.startsWith('$')) rawBefore = '$' + rawBefore.replace('$','');
            beforeNum = parseFloat(rawBefore.replace(/[^0-9.]/g,'')) || (ctNum / 0.4);
          } else {
            beforeNum = ctNum / 0.4; // 60% off => customer pays 40%
          }
          const beforeDiscountStr = `$${beforeNum.toFixed(2)}`;
          const savingsStr = `$${(beforeNum - ctNum).toFixed(2)}`;
          let promo;
          if (optPromo && optPromo.trim()) promo = optPromo.trim();
          else {
            const promoMap = { '10for30': 'Munchies · 60% off', 'doordash': 'Munchies · 60% off', 'ubereats': 'Munchies · 60% off' };
            promo = promoMap[dl.short] || 'Munchies · 60% off';
          }
          const orderId = `BB-${Math.floor(1000 + Math.random()*9000)}`;
          const scContainer = buildSuccessfulCheckoutContainer({
            store: storeName,
            customerId: customerId || interaction.user.id,
            chefId: interaction.user.id,
            customerTotalStr,
            beforeDiscountStr,
            savingsStr,
            promo,
            orderId
          });
          await scChannel.send({ components: [scContainer], flags: MessageFlagsBitField.Flags.IsComponentsV2 }).catch(e=>console.log('[sc] send fail', e.message));
          console.log(`[sc] logged to #${scChannel.name}`);
        } else {
          console.log('[sc] channel "successful checkouts" not found - skipping log');
        }
      } catch(e){ console.log('[sc] error', e.message); }
      console.log(`[✔] /complete by ${interaction.user.tag} +$2 bal $${newBal} total ${totalOrders} rating for ${customerId}`);
      return;
    }

    // === SLASH: /bal ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'bal') {
      const target = interaction.options.getUser('chef');
      const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
      const hasPaidRole = interaction.member.roles.cache.has(PAID_ROLE_ID);
      const paidRole = interaction.guild.roles.cache.get(PAID_ROLE_ID);
      const isHigherPaid = paidRole ? interaction.member.roles.highest.position >= paidRole.position : false;
      // If checking someone else, require Admin/Crown
      if (target && target.id !== interaction.user.id && !isAdmin && !hasPaidRole && !isHigherPaid) {
        await interaction.reply({ content: `❌ Only Admins/Crown can check others' balances.`, ephemeral: true });
        return;
      }
      // If no target, must be chef to check own
      if (!target && !hasChefPermission(interaction.member, interaction.guild) && !isAdmin) {
        await interaction.reply({ content: '❌ Only Chefs can check balance.', ephemeral: true });
        return;
      }
      const uid = target ? target.id : interaction.user.id;
      const bal = getChefBalance(uid);
      const title = target ? `💰 Balance for ${target.username}` : `💰 Your Balance`;
      const container = new ContainerBuilder().setAccentColor(0x2ECC71)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `**Chef:** <@${uid}>\n` +
          `**Total Orders:** \`${bal.totalOrders}\`\n` +
          `**Balance Owed:** \`$${bal.balance.toFixed(2)}\` • $2 per order`
        ));
      await interaction.reply({ components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2, ephemeral: true });
      return;
    }

    // === SLASH: /chefinfo ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'chefinfo') {
      const target = interaction.options.getUser('chef');
      const uid = target ? target.id : interaction.user.id;
      const member = interaction.guild.members.cache.get(uid);
      const displayName = member ? member.displayName : (target ? target.username : interaction.user.username);
      const bal = getChefBalance(uid);
      const rating = getChefRatingStats(uid);
      const avg = rating.count ? rating.avg.toFixed(2) : '—';
      const starsDisplay = rating.count ? '⭐'.repeat(Math.round(rating.avg)) + ` ${avg}/5` : 'No ratings yet';
      // star breakdown bars
      const maxCount = Math.max(...Object.values(rating.distribution), 1);
      const bar = (n) => {
        const c = rating.distribution[String(n)] || 0;
        const filled = Math.round((c / maxCount) * 8);
        return `${'█'.repeat(filled)}${'░'.repeat(8-filled)} \`${c}\``;
      };
      // today stats for this chef
      const todayStr = new Date().toISOString().split('T')[0];
      const todayOrders = (dailyData[todayStr]?.orders || []).filter(o => o.chefId === uid).length;
      const vouchPts = vouchPoints[uid] || 0;
      const isClocked = clockedIn.has(uid) ? '🟢 Clocked In' : '🔴 Clocked Out';
      const hasChefRole = member ? member.roles.cache.has(CHEF_ROLE_ID) || member.roles.highest.position >= (interaction.guild.roles.cache.get(CHEF_ROLE_ID)?.position ?? 0) : false;
      const container = new ContainerBuilder().setAccentColor(0xFFD700);
      // Header with user
      const header = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 👨‍🍳 Chef Info — ${displayName}\n<@${uid}> ${hasChefRole ? '• Chef' : '• Not Chef'} • ${isClocked}`))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(member?.displayAvatarURL({ extension: 'png', size: 256 }) || interaction.user.displayAvatarURL()).setDescription(displayName));
      container.addSectionComponents(header);
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `**📦 Orders**\n↳ **Total Orders:** \`${bal.totalOrders}\` • **Today:** \`${todayOrders}\`\n` +
        `↳ **Balance Owed:** \`$${bal.balance.toFixed(2)}\` • $2/order\n` +
        `↳ **Vouch Points:** \`${vouchPts}\``
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `**⭐ Ratings — ${rating.count} ${rating.count===1?'rating':'ratings'}**\n` +
        `↳ **Average:** ${starsDisplay}\n` +
        `↳ **Total Stars:** \`${rating.totalStars}\`\n` +
        `**Breakdown**\n` +
        `5⭐ ${bar(5)}\n` +
        `4⭐ ${bar(4)}\n` +
        `3⭐ ${bar(3)}\n` +
        `2⭐ ${bar(2)}\n` +
        `1⭐ ${bar(1)}`
      ));
      if (rating.recent && rating.recent.length) {
        const recentLines = rating.recent.slice(0,3).map(r => `• ${'⭐'.repeat(r.stars)} \`${r.stars}/5\` by <@${r.customerId}> <t:${Math.floor(r.ts/1000)}:R>`).join('\n');
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Recent**\n${recentLines}`));
      }
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Chef ID: \`${uid}\``));
      await interaction.reply({ components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2, ephemeral: true });
      return;
    }

    // === SLASH: /addbal ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'addbal') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await interaction.reply({ content: '❌ Only **Admins** can use `/addbal`.', ephemeral: true });
        return;
      }
      const target = interaction.options.getUser('chef');
      const amount = interaction.options.getNumber('amount');
      const bal = getChefBalance(target.id);
      bal.balance += amount;
      bal.totalOrders += Math.round(amount / 2); // keep orders in sync ($2/order)
      saveBalances();
      const container = new ContainerBuilder().setAccentColor(0x57F287)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`✅ Added **$${amount.toFixed(2)}** to <@${target.id}>\n**New Balance:** \`$${bal.balance.toFixed(2)}\` • Total Orders: \`${bal.totalOrders}\``));
      await interaction.reply({ components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2, ephemeral: true });
      return;
    }

    // === SLASH: /paid ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'paid') {
      const hasPaidRole = interaction.member.roles.cache.has(PAID_ROLE_ID) || interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
      // also allow higher than PAID role via hierarchy
      const paidRole = interaction.guild.roles.cache.get(PAID_ROLE_ID);
      const isHigher = paidRole ? interaction.member.roles.highest.position >= paidRole.position : false;
      if (!hasPaidRole && !isHigher) {
        await interaction.reply({ content: `❌ Only <@&${PAID_ROLE_ID}> or higher can use \`/paid\`.`, ephemeral: true });
        return;
      }
      const targetUser = interaction.options.getUser('user');
      const amount = interaction.options.getNumber('amount');
      const foundId = targetUser.id;
      const bal = getChefBalance(foundId);
      if (bal.balance <= 0) {
        await interaction.reply({ content: `⚠️ <@${foundId}> has no balance ($0.00).`, ephemeral: true });
        return;
      }
      if (amount > bal.balance + 0.001) {
        await interaction.reply({ content: `⚠️ <@${foundId}> only owes \`$${bal.balance.toFixed(2)}\` — can't pay \`$${amount.toFixed(2)}\`.`, ephemeral: true });
        return;
      }
      bal.balance = Math.max(0, bal.balance - amount);
      saveBalances();
      const container = new ContainerBuilder().setAccentColor(0x57F287)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `✅ Paid **$${amount.toFixed(2)}** to <@${foundId}>\n` +
          `**Remaining Balance:** \`$${bal.balance.toFixed(2)}\` • Total Orders: \`${bal.totalOrders}\``
        ));
      await interaction.reply({ components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2, ephemeral: true });
      return;
    }

    // === SLASH: /addorder ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'addorder') {
      const hasPaidRole = interaction.member.roles.cache.has(PAID_ROLE_ID) || interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
      const paidRole = interaction.guild.roles.cache.get(PAID_ROLE_ID);
      const isHigher = paidRole ? interaction.member.roles.highest.position >= paidRole.position : false;
      if (!hasPaidRole && !isHigher) {
        await interaction.reply({ content: `❌ Only <@&${PAID_ROLE_ID}> or higher can use \`/addorder\`.`, ephemeral: true });
        return;
      }
      const target = interaction.options.getUser('chef');
      const amount = interaction.options.getInteger('amount');
      const todayStr = new Date().toISOString().split('T')[0];
      if (!dailyData[todayStr]) dailyData[todayStr] = { orders: [] };
      for (let i=0; i<amount; i++) dailyData[todayStr].orders.push({ chefId: target.id, timestamp: Date.now(), hour: new Date().getHours() });
      const bal = getChefBalance(target.id);
      bal.totalOrders += amount;
      saveDaily();
      saveBalances();
      const container = new ContainerBuilder().setAccentColor(0x57F287)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`✅ Added **${amount}** orders to <@${target.id}> for today. Total now \`${getTodayStats().total}\``));
      await interaction.reply({ components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2, ephemeral: true });
      return;
    }

    // === SLASH: /today ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'today') {
      const stats = getTodayStats();
      const dateObj = new Date();
      const dateFormatted = dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      const total = stats.total;
      const busiest = stats.busiest ? `${stats.busiest.label} - ${stats.busiest.count} orders` : 'No orders yet';
      const topLines = [];
      const medals = ['🥇', '🥈', '🥉', '4.'];
      if (stats.top.length === 0) topLines.push('_No orders today_');
      else {
        for (let i = 0; i < stats.top.length; i++) {
          const [chefId, count] = stats.top[i];
          const member = interaction.guild.members.cache.get(chefId);
          const name = member ? member.displayName : `<@${chefId}>`;
          const medal = medals[i] || `${i+1}.`;
          topLines.push(`${medal} ${name} - \`${count} orders\``);
        }
      }
      const container = new ContainerBuilder().setAccentColor(0x9B59B6);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📋 Orders Today`));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${dateFormatted}`));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `🍔 **Orders Completed:** \`${total}\`\n` +
        `🟢 **Busiest Hour:** \`${busiest}\``
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 👨‍🍳 Top Chefs Today`));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(topLines.join('\n')));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Munchies`));
      await interaction.reply({ components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2, ephemeral: false });
      return;
    }

    // === SLASH: /vouch ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'vouch') {
      await interaction.deferReply({ ephemeral: true });
      const photo = interaction.options.getAttachment('photo');
      if (!photo || !photo.contentType?.startsWith('image/')) {
        await interaction.editReply({ content: '❌ Please upload a valid image.' });
        return;
      }
      try {
        const res = await fetch(photo.url);
        if (!res.ok) throw new Error('fetch failed');
        const buf = Buffer.from(await res.arrayBuffer());
        const watermarked = await watermarkBuffer(buf);
        const ext = photo.name?.split('.').pop() || 'png';
        const filename = `vouch_${Date.now()}.${ext.includes('png') ? 'png' : 'jpg'}`;
        const attachment = new AttachmentBuilder(watermarked, { name: filename });
        // Build vouch container like Cracky bot: username Vouch + image
        const vouchContainer = new ContainerBuilder().setAccentColor(0x2ECC71);
        vouchContainer.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${interaction.user.username} Vouch**`));
        const gallery = new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${filename}`));
        vouchContainer.addMediaGalleryComponents(gallery);
        // Send to channel where command was used (or vouches channel if you want)
        await interaction.channel.send({ components: [vouchContainer], flags: MessageFlagsBitField.Flags.IsComponentsV2, files: [attachment] });
        // Points like screenshot: @user you have earned 10 points!
        const newPoints = addVouchPoints(interaction.user.id, 10);
        const pointsContainer = new ContainerBuilder().setAccentColor(0x9B59B6)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎉 <@${interaction.user.id}> you have earned **10 points!** (Total: \`${newPoints}\`)`));
        await interaction.channel.send({ components: [pointsContainer], flags: MessageFlagsBitField.Flags.IsComponentsV2 });
        await interaction.editReply({ content: `✅ Vouch posted! You now have \`${newPoints} points\`.` });
      } catch (e) {
        console.log('[X] vouch', e.message);
        await interaction.editReply({ content: `❌ Failed to process vouch: ${e.message}` });
      }
      return;
    }

    // === BUTTON: Rate 1-5 ===
    if (interaction.isButton() && interaction.customId.startsWith('rate_')) {
      // Only customer can rate - handle both old (string) and new ({customerId, chefId}) store formats
      let entry = ratingStore.get(interaction.message.id);
      let allowedCustomer = null;
      let ratedChefId = null;
      if (entry) {
        if (typeof entry === 'string') allowedCustomer = entry;
        else { allowedCustomer = entry.customerId; ratedChefId = entry.chefId; }
      }
      if (!allowedCustomer) {
        // fallback: try ticketStore via channel
        const chStored = ticketStore.get(interaction.channelId);
        if (chStored?.user) allowedCustomer = chStored.user.id;
        else {
          const m = interaction.channel.topic?.match(/\b\d{17,20}\b/);
          if (m) allowedCustomer = m[0];
        }
      }
      // if we still don't have ratedChefId, try infer from channel claimed or last completer
      if (!ratedChefId) {
        // try claimed map, or look for recent chef from daily orders? fallback to ticket topic extra? keep null -> will try to find via channel perms
        const fallbackChef = claimedTickets.get(interaction.channelId);
        if (fallbackChef) ratedChefId = fallbackChef;
      }
      if (allowedCustomer && interaction.user.id !== allowedCustomer) {
        await interaction.reply({ content: '❌ Only the customer can rate their chef.', ephemeral: true });
        return;
      }
      const stars = parseInt(interaction.customId.split('_')[1], 10);
      // persist rating
      if (ratedChefId && stars >= 1 && stars <= 5) {
        addChefRating(ratedChefId, stars, interaction.user.id);
        console.log(`[⭐] ${stars}/5 for chef ${ratedChefId} by ${interaction.user.tag}`);
      }
      const thank = new ContainerBuilder().setAccentColor(0x57F287)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`⭐ Thanks for rating **${stars}/5**!`));
      await interaction.reply({ components: [thank], flags: MessageFlagsBitField.Flags.IsComponentsV2, ephemeral: true });
      try {
        const disabled = new ContainerBuilder().setAccentColor(0xFFD700)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`⭐ Rated **${stars}/5** by <@${interaction.user.id}>`));
        await interaction.message.edit({ components: [disabled], flags: MessageFlagsBitField.Flags.IsComponentsV2 }).catch(()=>{});
        ratingStore.delete(interaction.message.id);
      } catch {}
      return;
    }

  } catch (err) {
    console.error('[X] Interaction error:', err);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: '❌ Error: ' + err.message, ephemeral: true }).catch(()=>{});
    } else {
      await interaction.reply({ content: '❌ Error: ' + err.message, ephemeral: true }).catch(()=>{});
    }
  }
});

// Simple prefix command fallback: !panel (Admin only)
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.content.trim() === '!panel') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('❌ Only Admins can use `!panel`.');
    }
    const panel = buildPanel();
    const gifAtt2 = await getPanelGifAttachment();
    const files2 = gifAtt2 ? [gifAtt2] : [];
    await message.channel.send({ ...panel, files: files2 });
    await message.delete().catch(()=>{});
  }
});

client.login(BOT_TOKEN);
