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
const PANEL_CHANNEL_ID = process.env.PANEL_CHANNEL_ID || null;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID || '1542169772177760266';

const fs = require('fs');
const path = require('path');
const STATUS_FILE = path.join(__dirname, 'status.json');
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
}
// Clock in/out for chefs
const CLOCK_FILE = path.join(__dirname, 'clock.json');
const clockedIn = new Set();
try {
  if (fs.existsSync(CLOCK_FILE)) {
    const d = JSON.parse(fs.readFileSync(CLOCK_FILE, 'utf8'));
    if (Array.isArray(d.clockedIn)) d.clockedIn.forEach(id => clockedIn.add(id));
  }
} catch {}
function saveClock() {
  try { fs.writeFileSync(CLOCK_FILE, JSON.stringify({ clockedIn: [...clockedIn] }, null, 2)); } catch {}
}
function getChefPings() {
  if (clockedIn.size === 0) return '';
  return [...clockedIn].map(id => `<@${id}>`).join(' ');
}
async function updateStatusGif(open) {
  try {
    const guild = client.guilds.cache.get(GUILD_ID) || client.guilds.cache.first();
    if (!guild) return;
    let ch = null;
    try { ch = await guild.channels.fetch(STATUS_CHANNEL_ID); } catch {}
    if (!ch) ch = guild.channels.cache.get(STATUS_CHANNEL_ID);
    if (!ch) { console.log('[X] status gif channel not found'); return; }
    if (statusGifMessageId) {
      try {
        const old = await ch.messages.fetch(statusGifMessageId).catch(()=>null);
        if (old) await old.delete().catch(()=>{});
      } catch {}
      statusGifMessageId = null;
    }
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
      // Only ping @everyone when opening (closing is silent per request)
      const content = open ? '@everyone' : null;
      const allowed = open ? { parse: ['everyone'] } : {};
      const msg = await ch.send({ content, embeds: [embed], files: [attachment], allowedMentions: allowed }).catch(e=>{ console.log('[X] gif send attach failed', e.message); return null; });
      if (msg) saveStatus(open, msg.id);
      else saveStatus(open, null);
      return;
    } catch (e) {
      console.log('[X] gif fetch/attach failed', e.message, 'falling back to URL');
    }
    // fallback direct URL embed — only ping on open
    const embed = new EmbedBuilder()
      .setDescription(open ? 'The restaurant is now OPEN!' : 'The restaurant is now CLOSED!')
      .setImage(gifUrl)
      .setColor(open ? 0x57F287 : 0xED4245)
      .setFooter({ text: open ? 'OPEN!' : 'CLOSED' });
    const content2 = open ? '@everyone' : null;
    const allowed2 = open ? { parse: ['everyone'] } : {};
    const msg = await ch.send({ content: content2, embeds: [embed], allowedMentions: allowed2 }).catch(e=>{ console.log('[X] gif send fallback failed', e.message); return null; });
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

// In-memory ticket claim tracker: channelId -> userId
const claimedTickets = new Map();
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

  // Header
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${deal.emoji} ${deal.label}`)
  );
  const chefPings = getChefPings();
  const pingLine = chefPings ? `Hey <@${user.id}> ${chefPings} — thanks for ordering!` : `Hey <@${user.id}> — thanks for ordering!`;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(pingLine)
  );
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

  // Order details
  if (orderData) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### 📋 Order Details`));
    const lines = [];
    if (orderData.address) lines.push(`**Address:** ${orderData.address}`);
    if (orderData.store) lines.push(`**Store:** ${orderData.store}`);
    if (orderData.total) lines.push(`**Total:** ${orderData.total}`);
    if (orderData.grouplink) lines.push(`**Group Link:** ${orderData.grouplink}`);
    if (orderData.payment) lines.push(`**Payment:** ${orderData.payment}`);
    if (lines.length) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
  }

  // Status / claimed
  if (claimedBy) {
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`✅ **Claimed by <@${claimedBy}>** — this chef will assist you 1:1.`));
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`*A chef will claim your ticket shortly. — User ID: \`${user.id}\`*`));
  }

  // Buttons inside container (Components V2)
  const row = new ActionRowBuilder().addComponents(
    claimedBy
      ? new ButtonBuilder().setCustomId('unclaim_ticket').setLabel('Unclaim').setStyle(ButtonStyle.Secondary).setEmoji('↩️')
      : new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claim').setStyle(ButtonStyle.Success).setEmoji('🙋'),
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒')
  );
  container.addActionRowComponents(row);

  // Footer time
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Ticket for ${user.tag} • <t:${Math.floor(Date.now()/1000)}:R>`));

  return container;
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

  const pingIds = [...clockedIn];
  const allowed = { users: [user.id, ...pingIds] };
  // Only ping role if no one clocked in? No - clocked out means no ping, so don't add role
  if (pingIds.length === 0) {
    // no chef pings - just user
  } else {
    // pings are inside container via <@id> mentions, allowed via users
  }
  await channel.send({
    components: [container],
    flags: MessageFlagsBitField.Flags.IsComponentsV2,
    allowedMentions: { users: [user.id, ...pingIds] }
  });

  return { channel, deal };
}

function buildPanel() {
  const container = new ContainerBuilder().setAccentColor(0xF39C12);

  // Header section with text
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## 🍔 Yummy Orders`)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`Select your deal below to open a **private ticket** with our chefs. Your ticket will be between you and staff only.`)
  );
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

  // Deals showcase
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**🥬 10 FOR 30 DEALS**\nBest value bundle — 10 items for $30`)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**🚗 DOORDASH**\nGroup order discount — share your group link`)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**🛵 Uber Eats**\nFood delivery — Uber Eats orders`)
  );
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket_select')
    .setPlaceholder('🛒 Choose your deal...')
    .addOptions(
      { label: '10 FOR 30 DEALS 🥬', value: 'deal_10for30', description: 'Open ticket for 10 for 30 deal', emoji: '🥬' },
      { label: 'DOORDASH 🚗', value: 'deal_doordash', description: 'Open ticket for DOORDASH', emoji: '🚗' },
      { label: 'Uber Eats 🛵', value: 'deal_ubereats', description: 'Open ticket for Uber Eats', emoji: '🛵' }
    );
  const row = new ActionRowBuilder().addComponents(menu);
  container.addActionRowComponents(row);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# Select a deal to get started • Tickets are private`)
  );

  return { components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2 };
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
];

async function registerCommands(guilds) {
  if (!CLIENT_ID) {
    console.log('[!] Skipping command register - set CLIENT_ID in .env');
    return;
  }
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const targets = GUILD_ID ? [GUILD_ID] : (guilds ? [...guilds.keys()] : []);
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
        // If ticket was unclaimed (moved back to Tickets) but Map stale, clear it
        if (interaction.channel.parentId === TICKET_CATEGORY_ID) {
          claimedTickets.delete(channelId);
        } else {
          await interaction.reply({ content: `⚠️ Already claimed by <@${claimedBy}>`, ephemeral: true });
          return;
        }
      }

      claimedTickets.set(channelId, interaction.user.id);

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
      if (!claimedTickets.has(channelId)) {
        await interaction.reply({ content: '⚠️ Ticket is not claimed.', ephemeral: true });
        return;
      }
      const claimedBy = claimedTickets.get(channelId);
      // Only claimer or Admin can unclaim
      const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
      if (interaction.user.id !== claimedBy && !isAdmin) {
        await interaction.reply({ content: `❌ Only <@${claimedBy}> or an Admin can unclaim this.`, ephemeral: true });
        return;
      }
      claimedTickets.delete(channelId);
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
      // Restore permissions for all chefs
      try {
        await interaction.channel.permissionOverwrites.edit(CHEF_ROLE_ID, { ViewChannel: true, SendMessages: true }).catch(()=>{});
        await interaction.channel.permissionOverwrites.delete(claimedBy).catch(()=>{});
      } catch {}
      // Resend fresh claim prompt so chefs can press Claim again
      try {
        const stored = ticketStore.get(channelId);
        if (stored) {
          const fresh = buildTicketContainer(stored.deal, stored.orderData, stored.user, null);
          const pingIds = [...clockedIn];
          await interaction.channel.send({ components: [fresh], flags: MessageFlagsBitField.Flags.IsComponentsV2, allowedMentions: { users: [stored.user.id, ...pingIds] } }).catch(()=>{});
        }
      } catch {}
      console.log(`[↩️] Ticket ${interaction.channel.name} unclaimed by ${interaction.user.tag}`);
      return;
    }

    // === BUTTON: Close ===
    if (interaction.isButton() && interaction.customId === 'close_ticket') {
      await interaction.reply({ content: '🔒 Closing ticket in 3 seconds...' });
      claimedTickets.delete(interaction.channelId);
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
      await targetChannel.send(panel);
      await interaction.reply({ content: `✅ Panel sent in <#${targetChannel.id}>`, ephemeral: true });
      return;
    }

    // === SLASH: /deals ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'deals') {
      const dealsText = `**Available Restaurants**\n▸  Domino's\n▸  Papa John's\n▸  Church's Chicken\n▸  Jersey Mike's Subs\n▸  Panda Express\n▸  Auntie Anne's\n▸  Panera Bread\n▸  IHOP  ·  not for everyone\n▸  Smoothie King  ·  sometimes\n▸  Applebee's\n▸  Tropical Smoothie Cafe\n▸  Sonic\n▸  Buffalo Wild Wings\n▸  Marco's Pizza\n▸  Jim N Nick's Bar-B-Q\n▸  CAVA\n▸  Fluffies Hot Chicken\n▸  Steak 'n Shake\n▸  Taco Cabana\n▸  Raising Cane's Chicken Fingers  ·  pickup only\n▸  McAlister's Deli\n▸  Carl's Jr.\n▸  Whataburger\n▸  Zaxby's\n▸  Red Lobster\n▸  P.F. Chang's\n▸  Jamba\n▸  Playa Bowls\n▸  Five Guys\n▸  The Habit Burger Grill\n▸  Smashburger\n▸  Insomnia Cookies\n▸  Qdoba\n▸  Jollibee\n▸  Wingstop`;
      const dealsContainer = new ContainerBuilder().setAccentColor(0x2ECC71)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(dealsText));
      await interaction.reply({ components: [dealsContainer], flags: MessageFlagsBitField.Flags.IsComponentsV2 });
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
        } else {
          await interaction.reply({ content: `⚠️ Already claimed by <@${cBy}>`, ephemeral: true });
          return;
        }
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
      if (!claimedTickets.has(interaction.channelId)) {
        await interaction.reply({ content: '⚠️ This ticket is not claimed.', ephemeral: true });
        return;
      }
      const claimedBy = claimedTickets.get(interaction.channelId);
      const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
      if (interaction.user.id !== claimedBy && !isAdmin) {
        await interaction.reply({ content: `❌ Only <@${claimedBy}> or an Admin can unclaim.`, ephemeral: true });
        return;
      }
      claimedTickets.delete(interaction.channelId);
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
          await interaction.channel.send({ components: [fresh], flags: MessageFlagsBitField.Flags.IsComponentsV2, allowedMentions: { users: [stored.user.id, ...pingIds2] } }).catch(()=>{});
        }
      } catch {}
      console.log(`[↩️] Ticket ${interaction.channel.name} unclaimed via /unclaim by ${interaction.user.tag}`);
      return;
    }

    // === SLASH: /close ===
    if (interaction.isChatInputCommand() && interaction.commandName === 'close') {
      await interaction.reply({ content: '🔒 Closing...' });
      claimedTickets.delete(interaction.channelId);
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
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`How to use Yummy bot — clock, status & tickets`));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### 🕐 Clock In / Out\n` +
        `• \`/clockin\` — Clock in, start receiving ticket pings (<@&${CHEF_ROLE_ID}>)\n` +
        `• \`/clockout\` — Clock out, stop receiving pings\n` +
        `• Only clocked-in chefs get pinged when a customer creates a ticket`
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### 🟢 / 🔴 Open & Close\n` +
        `• \`/open\` — Set restaurant to **open**, allow tickets, rename status to \`🟢-status\`, send open gif with @everyone\n` +
        `• \`/closed\` — Set to **closed**, block new tickets (replies *Restaurant is currently closed*), rename to \`🔴-status\`, send closed gif\n` +
        `• Requires Chef+ or Manage Server`
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### 🎟️ Claim & Unclaim\n` +
        `• **Claim button** or \`/claim\` — Claim a ticket, locks it 1:1 (other chefs read-only), moves to \`Claimed\` category, renames to \`claimed-<you>\`\n` +
        `• **Unclaim button** or \`/unclaim\` — Release your claimed ticket, moves back to \`Tickets\`, restores permissions, re-enables Claim\n` +
        `• Only the claimer or an Admin can unclaim`
      ));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `### 🔧 Admin & Utils\n` +
        `• \`/panel\` / \`!panel\` — Post ticket panel (Admin only)\n` +
        `• \`/faq\` — Post How To Order guide (Admin only)\n` +
        `• \`/deals\` — List all restaurants (anyone)\n` +
        `• \`/close\` — Close & delete current ticket`
      ));
      await interaction.reply({ components: [container], flags: MessageFlagsBitField.Flags.IsComponentsV2, ephemeral: true });
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
    await message.channel.send(panel);
    await message.delete().catch(()=>{});
  }
});

client.login(BOT_TOKEN);
