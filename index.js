require('dotenv').config();

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { Client, GatewayIntentBits, ChannelType, EmbedBuilder } = require('discord.js');

const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const pendingDeletions = new Map();
const pendingRoleDeletions = new Map();
const pendingWarningClears = new Map();

function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, minimum), maximum);
}

const NEWS_STATE_PATH = path.join(__dirname, 'news-state.json');
const WARNINGS_STATE_PATH = path.join(__dirname, 'warnings-state.json');
const AI_MODEL = process.env.AI_MODEL || 'gpt-5.6-luna';
const AI_MAX_OUTPUT_TOKENS = boundedInteger(process.env.AI_MAX_OUTPUT_TOKENS, 500, 100, 2000);
const AI_RATE_LIMIT_MAX = boundedInteger(process.env.AI_RATE_LIMIT_MAX, 5, 1, 20);
const AI_RATE_LIMIT_WINDOW_MS = boundedInteger(process.env.AI_RATE_LIMIT_WINDOW_MINUTES, 10, 1, 60) * 60 * 1000;
const AI_CONVERSATION_TIMEOUT_MS = boundedInteger(process.env.AI_CONVERSATION_TIMEOUT_MINUTES, 3, 1, 60) * 60 * 1000;
const AI_CONVERSATION_MAX_TURNS = boundedInteger(process.env.AI_CONVERSATION_MAX_TURNS, 4, 1, 10);
const AI_CHANNEL_IDS = new Set((process.env.AI_CHANNEL_IDS || '').split(',').map(id => id.trim()).filter(Boolean));
const aiRequestTimes = new Map();
const aiConversations = new Map();
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const NEWS_POLL_INTERVAL_MS = Math.max(
    Number.parseInt(process.env.NEWS_POLL_INTERVAL_MINUTES || '1', 10) * 60 * 1000,
    60 * 1000
);
const NEWS_LATEST_BACKFILL_VERSION = 1;
const NEWS_SOURCES = [
    { key: 'tarky', category: 'Tarky', label: 'Escape from Tarkov', type: 'steam', appId: 3932890 },
    { key: 'division-2', category: 'Division 2', label: 'The Division 2', type: 'steam', appId: 2221490 },
    { key: 'siege', category: 'Siege', label: 'Rainbow Six Siege', type: 'steam', appId: 359550 },
    { key: 'big-walk', category: 'Big Walk', label: 'Big Walk', type: 'steam', appId: 1478500 },
    { key: 'pokemmo', category: 'POKEMMO', label: 'PokeMMO', type: 'rss', url: 'https://forums.pokemmo.com/index.php?/rss/1-updates-announcements.xml/' },
    { key: 'valorant', category: 'Valorant', label: 'VALORANT', type: 'valorant' },
    { key: 'destiny', category: 'Destiny', label: 'Destiny 2', type: 'steam', appId: 1085660 }
];

function loadNewsState() {
    try {
        return JSON.parse(fs.readFileSync(NEWS_STATE_PATH, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('Could not read news state:', error);
        return {};
    }
}

let newsState = loadNewsState();
let newsPollInProgress = false;

function loadWarningsState() {
    try {
        const state = JSON.parse(fs.readFileSync(WARNINGS_STATE_PATH, 'utf8'));
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
            throw new Error('Warning state must be an object.');
        }
        return state;
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw new Error(`Could not load warning history: ${error.message}`);
    }
}

let warningsState = loadWarningsState();

function saveWarningsState() {
    const temporaryPath = `${WARNINGS_STATE_PATH}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(warningsState, null, 2));
    fs.renameSync(temporaryPath, WARNINGS_STATE_PATH);
}

function getWarnings(guildId, memberId) {
    return warningsState[guildId]?.[memberId] || [];
}

function addWarning(guildId, member, moderator, reason) {
    warningsState[guildId] ??= {};
    warningsState[guildId][member.id] ??= [];
    const warnings = warningsState[guildId][member.id];
    warnings.push({
        reason,
        moderatorId: moderator.id,
        moderatorTag: moderator.tag,
        createdAt: Date.now()
    });
    try {
        saveWarningsState();
        return warnings.length;
    } catch (error) {
        warnings.pop();
        if (warnings.length === 0) delete warningsState[guildId][member.id];
        if (Object.keys(warningsState[guildId]).length === 0) delete warningsState[guildId];
        throw error;
    }
}

function clearWarnings(guildId, memberId) {
    if (!warningsState[guildId]?.[memberId]) return 0;
    const warnings = warningsState[guildId][memberId];
    const count = warnings.length;
    delete warningsState[guildId][memberId];
    if (Object.keys(warningsState[guildId]).length === 0) delete warningsState[guildId];
    try {
        saveWarningsState();
        return count;
    } catch (error) {
        warningsState[guildId] ??= {};
        warningsState[guildId][memberId] = warnings;
        throw error;
    }
}

function saveNewsState() {
    fs.writeFileSync(NEWS_STATE_PATH, JSON.stringify(newsState, null, 2));
}

function decodeXml(value = '') {
    return value
        .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function rssValue(item, tag) {
    const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? decodeXml(match[1].trim()) : '';
}

function stripMarkup(value = '') {
    return decodeXml(value)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function getSteamNews(source) {
    const url = new URL('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/');
    url.search = new URLSearchParams({
        appid: String(source.appId),
        count: '10',
        maxlength: '1000',
        feeds: 'steam_community_announcements',
        format: 'json'
    }).toString();

    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Steam returned ${response.status}`);
    const body = await response.json();
    return (body.appnews?.newsitems || []).map(item => ({
        id: String(item.gid),
        title: item.title,
        url: item.url,
        description: stripMarkup(item.contents),
        publishedAt: item.date ? new Date(item.date * 1000) : new Date()
    }));
}

async function getRssNews(source) {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`RSS feed returned ${response.status}`);
    const xml = await response.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(match => {
        const item = match[1];
        const link = rssValue(item, 'link');
        return {
            id: rssValue(item, 'guid') || link || rssValue(item, 'title'),
            title: rssValue(item, 'title'),
            url: link,
            description: stripMarkup(rssValue(item, 'description')),
            publishedAt: new Date(rssValue(item, 'pubDate'))
        };
    });
}

async function getValorantNews() {
    const response = await fetch('https://playvalorant.com/en-us/news/', { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`VALORANT returned ${response.status}`);
    const html = await response.text();
    return [...html.matchAll(/<a[^>]+data-testid="articlefeaturedcard-component"[\s\S]*?<\/a>/gi)]
        .map(match => {
            const card = match[0];
            const href = card.match(/\shref="([^"]+)"/i)?.[1] || '';
            const title = card.match(/data-testid="card-title">([\s\S]*?)<\/div>/i)?.[1] || '';
            const description = card.match(/data-testid="card-description"[\s\S]*?<div>([\s\S]*?)<\/div>/i)?.[1] || '';
            const publishedAt = card.match(/<time[^>]+dateTime="([^"]+)"/i)?.[1] || '';
            return {
                id: href,
                title: stripMarkup(title),
                url: new URL(href, 'https://playvalorant.com').toString(),
                description: stripMarkup(description),
                publishedAt: new Date(publishedAt)
            };
        })
        .filter(item => item.id && item.title)
        .sort((a, b) => b.publishedAt - a.publishedAt);
}

async function getNews(source) {
    if (source.type === 'steam') return getSteamNews(source);
    if (source.type === 'valorant') return getValorantNews(source);
    return getRssNews(source);
}

async function getNewsWebhook(channel, source) {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(item => item.owner?.id === discord.user.id && item.name === `${source.label} News`);
    if (!webhook) {
        webhook = await channel.createWebhook({ name: `${source.label} News`, reason: `Official ${source.label} news relay` });
    }
    return webhook;
}

async function newsAlreadyPosted(channel, item) {
    const messages = await channel.messages.fetch({ limit: 100 });
    return messages.some(message => message.embeds.some(embed => embed.url === item.url));
}

async function deliverNews(channel, source, item) {
    const webhook = await getNewsWebhook(channel, source);
    const description = item.description || 'Open the official announcement for details.';
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({ name: `${source.label} — Official News` })
        .setTitle(item.title.slice(0, 256))
        .setURL(item.url)
        .setDescription(description.slice(0, 4000))
        .setFooter({ text: 'Official developer/publisher announcement' });
    if (!Number.isNaN(item.publishedAt.getTime())) embed.setTimestamp(item.publishedAt);
    if (await newsAlreadyPosted(channel, item)) return false;
    await webhook.send({ embeds: [embed] });
    return true;
}

async function pollNews({ initialise = false } = {}) {
    if (newsPollInProgress) return;
    newsPollInProgress = true;
    try {
    for (const guild of discord.guilds.cache.values()) {
        await guild.channels.fetch();
        for (const source of NEWS_SOURCES) {
            const category = findCategory(guild, source.category);
            const channel = category && findTextChannel(guild, 'news', source.category);
            if (!channel) continue;

            const stateKey = `${guild.id}:${source.key}`;
            try {
                const items = await getNews(source);
                const delivered = new Set(newsState[stateKey] || []);

                const backfillKey = `${stateKey}:latestBackfill`;
                if (initialise && newsState[backfillKey] !== NEWS_LATEST_BACKFILL_VERSION) {
                    const latest = items.find(item => item.id);
                    if (latest) {
                        await deliverNews(channel, source, latest);
                        delivered.add(latest.id);
                    }
                    newsState[stateKey] = [...items.map(item => item.id).filter(Boolean), ...delivered].slice(0, 100);
                    newsState[backfillKey] = NEWS_LATEST_BACKFILL_VERSION;
                    saveNewsState();
                    continue;
                }

                if (initialise && !newsState[stateKey]) {
                    newsState[stateKey] = items.map(item => item.id).filter(Boolean).slice(0, 100);
                    await getNewsWebhook(channel, source);
                    continue;
                }

                const newItems = items.filter(item => item.id && !delivered.has(item.id)).reverse();
                for (const item of newItems) await deliverNews(channel, source, item);
                newsState[stateKey] = [...newItems.map(item => item.id), ...delivered].slice(0, 100);
                saveNewsState();
            } catch (error) {
                console.error(`News update failed for ${guild.name} / ${source.category}:`, error);
            }
        }
    }
    saveNewsState();
    } finally {
        newsPollInProgress = false;
    }
}

function pendingKey(message) {
    return `${message.guild.id}:${message.author.id}`;
}

function isOwner(message) {
    return message.author.id === process.env.OWNER_ID;
}

function isModerator(message) {
    const moderatorRoleIds = (process.env.MODERATOR_ROLE_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    return moderatorRoleIds.some(roleId => message.member?.roles.cache.has(roleId));
}

function isAdministrator(message) {
    return message.member?.permissions.has('Administrator') ?? false;
}

function isAuthorisedStaff(message) {
    return isOwner(message) || isAdministrator(message) || isModerator(message);
}

function getBotMember(message) {
    return message.guild.members.me;
}

function findCategory(guild, name) {
    return guild.channels.cache.find(
        channel =>
            channel.type === ChannelType.GuildCategory &&
            channel.name.toLowerCase() === name.trim().toLowerCase()
    );
}

function findTextChannel(guild, name, categoryName = null) {
    return guild.channels.cache.find(channel => {
        if (
            ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
            channel.name.toLowerCase() !== name.trim().toLowerCase()
        ) {
            return false;
        }

        if (!categoryName) return true;

        return (
            channel.parent &&
            channel.parent.name.toLowerCase() === categoryName.trim().toLowerCase()
        );
    });
}

async function findMember(guild, input) {
    const members = await guild.members.fetch();
    console.log(`👥 Server members loaded: ${members.size}`);

    let member = null;
    const mentionMatch = input.match(/^<@!?(\d+)>$/);

    if (mentionMatch) member = members.get(mentionMatch[1]);
    if (!member && /^\d+$/.test(input)) member = members.get(input);

    if (!member) {
        const searchName = input
            .replace(/^<@!?/, '')
            .replace(/>$/, '')
            .trim()
            .toLowerCase();

        member = members.find(m =>
            m.user.username.toLowerCase() === searchName ||
            m.displayName.toLowerCase() === searchName ||
            m.user.tag.toLowerCase() === searchName
        );
    }

    return { member, count: members.size };
}

async function checkChannelPermissions(channel, member) {
    const permissions = channel.permissionsFor(member);
    return {
        viewChannel: permissions.has('ViewChannel'),
        sendMessages: permissions.has('SendMessages'),
        readHistory: permissions.has('ReadMessageHistory'),
        manageChannels: permissions.has('ManageChannels')
    };
}

async function clearMessages(channel, amount) {
    const messages = await channel.messages.fetch({
        limit: Math.min(amount + 1, 100)
    });

    const deletable = messages.filter(
        msg => Date.now() - msg.createdTimestamp < 14 * 24 * 60 * 60 * 1000
    );

    if (deletable.size === 0) return 0;
    const deleted = await channel.bulkDelete(deletable, true);
    return deleted.size;
}

async function clearAllMessages(channel) {
    let totalDeleted = 0;

    while (true) {
        const messages = await channel.messages.fetch({ limit: 100 });
        const deletable = messages.filter(
            msg => Date.now() - msg.createdTimestamp < 14 * 24 * 60 * 60 * 1000
        );

        if (deletable.size === 0) break;

        const deleted = await channel.bulkDelete(deletable, true);
        totalDeleted += deleted.size;

        if (messages.size < 100) break;
    }

    return totalDeleted;
}

function naturalHelpRequested(content) {
    const helpRequest = content.trim().toLowerCase();
    return [
        'help',
        'help me',
        'commands',
        'show commands',
        'show me your commands',
        'list commands',
        'what can you do',
        'what can hallkeeper do',
        'what commands do you have',
        'what can hall keeper do',
        'what are your commands',
        'what are the commands',
        'how do i use you',
        'how do i use hallkeeper'
    ].includes(helpRequest);
}

function findChannel(guild, name, categoryName = null) {
    return guild.channels.cache.find(channel => {
        if (
            channel.type === ChannelType.GuildCategory ||
            channel.name.toLowerCase() !== name.trim().toLowerCase()
        ) {
            return false;
        }

        if (!categoryName) return true;
        return channel.parent && channel.parent.name.toLowerCase() === categoryName.trim().toLowerCase();
    });
}

async function ensureGuildPermission(message, permission, label) {
    if (getBotMember(message).permissions.has(permission)) return true;
    await message.reply(`❌ HallKeeper doesn't have the **${label}** permission.`);
    return false;
}

async function ensureChannelPermission(message, channel, permission, label) {
    if (channel.permissionsFor(getBotMember(message)).has(permission)) return true;
    await message.reply(`❌ HallKeeper doesn't have the **${label}** permission in ${channel}.`);
    return false;
}

function normaliseNaturalRequest(content) {
    return content
        .trim()
        .replace(/^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i, '')
        .replace(/^please\s+/i, '')
        .replace(/^(?:hey|hi|hello)\s+(?:hall\s*keeper|hallkeeper)[,!:\s]*/i, '')
        .replace(/^(?:hall\s*keeper|hallkeeper)[,!:\s]*/i, '')
        .trim();
}

const naturalIntentHistory = new Map();

function naturalIntentKey(message) {
    return `${message.guild.id}:${message.channel.id}:${message.author.id}`;
}

function looksLikeNaturalManagementRequest(content) {
    return /\b(?:create|make|add|build|set\s+up|delete|remove|rename|move|put|place|apply|copy|set|update|change|clear|kick|ban|mute|unmute|warn|role|channel|category|permission|voice|user\s+limit|message)\b/i.test(content);
}

async function translateNaturalRequest(message, content) {
    if (!openai) return null;
    const key = naturalIntentKey(message);
    const history = naturalIntentHistory.get(key) || [];
    try {
        const response = await openai.responses.create({
            model: AI_MODEL,
            store: false,
            max_output_tokens: 350,
            instructions: 'You are the conversational interpretation layer for a Discord server-management bot. Interpret ordinary human language, not slash commands. Do not execute actions. Return only valid JSON with this shape: {"canonical_request":"...","reply":"..."}. Use canonical_request when the request contains enough information for a supported action; otherwise leave it empty and use reply to ask one concise, natural follow-up question. Never invent category names, channel names, members, roles, limits, or permissions. Preserve names and numbers exactly. Supported canonical requests include creating, deleting, renaming, moving, and listing channels/categories; applying permissions; setting voice limits; managing roles and members; sending messages; and clearing messages. The deterministic handler performs validation and confirmations. If the user is merely chatting or asking an unrelated question, return both fields empty.',
            input: JSON.stringify({ previous_requests: history, current_request: content })
        });
        const raw = response.output_text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return {
            canonicalRequest: typeof parsed.canonical_request === 'string' ? parsed.canonical_request.trim() : '',
            reply: typeof parsed.reply === 'string' ? parsed.reply.trim() : ''
        };
    } catch (error) {
        console.error('Natural language translation error:', error);
        return null;
    }
}

function splitNaturalChannelNames(value) {
    return value.replace(/[.!?]+\s*$/, '').split(/\s*(?:,|\band\b)\s*/i)
        .map(name => name.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean);
}

function parseNaturalChannelLayout(content) {
    const text = normaliseNaturalRequest(content);
    const categoryMatch = text.match(/^(?:can\s+you\s+)?(?:please\s+)?(?:create|make|add|set\s+up)\s+(?:a\s+)?(?:new\s+)?(.+?)\s+category\s+with\s+(.+)$/i);
    if (!categoryMatch) return null;
    const categoryName = categoryMatch[1].trim();
    let remainder = categoryMatch[2].trim();
    const correspondingLimitRequested = /set\s+(?:the\s+)?user\s+limit\s+(?:per\s+channel\s+)?to\s+the\s+corresponding\s+number/i.test(remainder);
    remainder = remainder.replace(/\s*(?:[.!]?\s+and\s+)?set\s+(?:the\s+)?user\s+limit\s+(?:per\s+channel\s+)?to\s+the\s+corresponding\s+number[.!]?\s*$/i, '').trim();
    const voiceMatch = remainder.match(/^(.*?)(?:[.!]?\s+and\s+)?(\d+)\s+voice\s+channels?\s+(?:called|named)\s+(.+?)[.!]?$/i);
    let textChannelPart = remainder;
    let voiceChannels = [];
    if (voiceMatch) {
        textChannelPart = voiceMatch[1].trim().replace(/[.!]+$/, '').trim();
        const count = Number.parseInt(voiceMatch[2], 10);
        const voiceName = voiceMatch[3].trim().replace(/^['"`]|['"`]$/g, '');
        const range = voiceName.match(/^(\d+)\s*[-–]\s*(\d+)\s+(.+)$/);
        if (range) {
            const first = Number.parseInt(range[1], 10);
            const last = Number.parseInt(range[2], 10);
            if (last >= first && last - first + 1 <= 50) {
                voiceChannels = Array.from({ length: last - first + 1 }, (_, offset) => ({
                    name: `${first + offset} ${range[3].trim()}`,
                    userLimit: correspondingLimitRequested ? first + offset : null
                }));
            }
        }
        if (voiceChannels.length === 0) voiceChannels = Array.from({ length: Math.min(count, 50) }, (_, index) => ({
            name: `${index + 1} ${voiceName}`,
            userLimit: correspondingLimitRequested ? index + 1 : null
        }));
    }
    const textChannels = splitNaturalChannelNames(textChannelPart.replace(/\s+text\s+channels?\s*$/i, ''));
    return textChannels.length && voiceChannels.length ? { categoryName, textChannels, voiceChannels } : null;
}

function parseNaturalPermissionCopyRequest(content) {
    const text = normaliseNaturalRequest(content);
    const match = text.match(/^(?:can\s+you\s+)?(?:please\s+)?(?:apply|copy|use|set)\s+(?:the\s+)?same\s+permissions?\s+as\s+(?:the\s+)?(.+?)(?:\s+category)?\s+(?:to|onto|on|for)\s+(?:the\s+)?(.+?)\s+category(?:\s+and\s+(?:its\s+)?channels?)?(?:\s+please)?[.!]?$/i);
    if (!match) return null;
    return { sourceCategoryName: match[1].trim().replace(/^other\s+/i, ''), targetCategoryName: match[2].trim() };
}

function findPermissionTemplateCategory(guild, name) {
    const exact = findCategory(guild, name);
    if (exact) return exact;
    if (/gaming/i.test(name)) return findGamingPermissionTemplateCategory(guild);
    return null;
}

function findGamingPermissionTemplateCategory(guild) {
    for (const source of NEWS_SOURCES) {
        const category = findCategory(guild, source.category);
        if (category) return category;
    }
    return guild.channels.cache.find(channel =>
        channel.type === ChannelType.GuildCategory && findTextChannel(guild, 'news', channel.name)
    ) || null;
}

function getPermissionOverwrites(channel, guild) {
    const botMember = guild.members.me;
    let skipped = 0;
    const overwrites = [...channel.permissionOverwrites.cache.values()].flatMap(overwrite => {
        if (overwrite.type !== 0) {
            skipped++;
            return [];
        }
        const role = guild.roles.cache.get(overwrite.id);
        if (!role || role.managed || (role.id !== guild.id && (!botMember || role.position >= botMember.roles.highest.position))) {
            skipped++;
            return [];
        }
        return [{ id: overwrite.id, type: overwrite.type, allow: overwrite.allow, deny: overwrite.deny }];
    });
    return { overwrites, skipped };
}

async function applyPermissionTemplate(target, source) {
    const { overwrites, skipped } = getPermissionOverwrites(source, target.guild);
    await target.permissionOverwrites.set(overwrites);
    const childChannels = target.guild.channels.cache.filter(channel => channel.parentId === target.id);
    for (const channel of childChannels.values()) await channel.permissionOverwrites.set(overwrites);
    return { childChannelCount: childChannels.size, skipped };
}

function parseNaturalCategoryPositionRequest(content) {
    const text = normaliseNaturalRequest(content);
    const match = text.match(/^(?:can\s+you\s+)?(?:please\s+)?(?:place|put|move)\s+(?:the\s+)?(.+?)\s+category\s+(above|below|before|after|under)\s+(?:the\s+)?(.+?)(?:\s+category)?(?:\s+please)?[.!]?$/i);
    if (!match) return null;
    return {
        categoryName: match[1].trim(),
        direction: /above|before/i.test(match[2]) ? 'above' : 'below',
        referenceCategoryName: match[3].trim()
    };
}

function parseNaturalVoiceLimitRequest(content) {
    const text = normaliseNaturalRequest(content);
    const match = text.match(/^(?:can\s+you\s+)?(?:please\s+)?(?:set|update|change)\s+(?:the\s+)?user\s+limit\s+(?:for|on|of)\s+#?(.+?)\s+(?:to|at)\s+(\d+)\s*(?:users?|people|members?)?(?:\s+please)?[.!]?$/i);
    if (!match) return null;
    return { channelName: match[1].trim(), userLimit: Math.min(Number.parseInt(match[2], 10), 99) };
}

function parseNaturalCategoryVoiceLimitRequest(content) {
    const text = normaliseNaturalRequest(content);
    const match = text.match(/^(?:in\s+)?(.+?)(?:\s*[,;:]\s*|\s+)set\s+(?:the\s+)?(?:vc|voice\s+channels?)\s+(?:user\s+)?limits?\s+to\s+(?:the\s+)?matching\s+number(?:\s+please)?[.!]?$/i);
    if (!match) return null;
    return { categoryName: match[1].trim() };
}

function parseNaturalNamedVoiceLimitsRequest(content) {
    const text = normaliseNaturalRequest(content);
    const match = text.match(/^in\s+(.+?)\s+set\s+(.+)$/i);
    if (!match) return null;
    const groupMatch = match[2].match(/^(.+?)\s+(?:vc|voice\s+channels?)\s+user\s+limits?\s+(?:to|at)\s+(\d+)\s*(?:users?|people|members?)?$/i);
    if (groupMatch) {
        const channelNames = groupMatch[1].split(/\s*,\s*|\s+and\s+/i).map(name => name.trim()).filter(Boolean);
        return channelNames.length ? {
            categoryName: match[1].trim(),
            assignments: channelNames.map(channelName => ({ channelName, userLimit: Math.min(Number.parseInt(groupMatch[2], 10), 99) }))
        } : null;
    }
    const assignments = match[2].split(/\s*,\s*|\s+and\s+/i).map(part => {
        const assignment = part.replace(/^the\s+/i, '').trim().match(/^(.+?)\s+(?:user\s+limit\s+)?(?:to|at)\s+(\d+)\s*(?:users?|people|members?)?$/i);
        return assignment ? { channelName: assignment[1].trim(), userLimit: Math.min(Number.parseInt(assignment[2], 10), 99) } : null;
    });
    return assignments.length && assignments.every(Boolean) ? { categoryName: match[1].trim(), assignments } : null;
}

function canMakeAiRequest(userId) {
    const now = Date.now();
    const recentRequests = (aiRequestTimes.get(userId) || []).filter(
        timestamp => now - timestamp < AI_RATE_LIMIT_WINDOW_MS
    );
    if (recentRequests.length >= AI_RATE_LIMIT_MAX) {
        aiRequestTimes.set(userId, recentRequests);
        return false;
    }
    recentRequests.push(now);
    aiRequestTimes.set(userId, recentRequests);
    return true;
}

async function sendAiReply(message, text) {
    const chunks = [];
    let remaining = text.trim();
    while (remaining.length > 1900) {
        let splitAt = remaining.lastIndexOf('\n', 1900);
        if (splitAt < 500) splitAt = remaining.lastIndexOf(' ', 1900);
        if (splitAt < 500) splitAt = 1900;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
    }
    chunks.push(remaining || "I couldn't produce a text response for that.");

    const sentMessages = [await message.reply(chunks.shift())];
    for (const chunk of chunks) sentMessages.push(await message.channel.send(chunk));
    return sentMessages;
}

function aiConversationKey(message) {
    return `${message.guild.id}:${message.channel.id}:${message.author.id}`;
}

function clearExpiredAiConversations() {
    const now = Date.now();
    for (const [key, conversation] of aiConversations) {
        if (now - conversation.lastActivityAt > AI_CONVERSATION_TIMEOUT_MS) aiConversations.delete(key);
    }
}

function buildConversationPrompt(conversation, prompt) {
    if (!conversation) return prompt;
    const history = conversation.turns
        .map(turn => `Member: ${turn.prompt}\nHallKeeper: ${turn.reply}`)
        .join('\n\n');
    return `Continue this conversation using only the context below.\n\n${history}\n\nMember: ${prompt}`;
}

function isCloseConversationRequest(prompt) {
    const text = prompt.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim();
    // A contrast usually signals that the member has a follow-up rather than wants to close.
    if (/\bbut\b/.test(text)) return false;
    return [
        /(?:please\s+)?(?:close|end|stop)\s+(?:this\s+|the\s+)?(?:chat|conversation|thread)\b/,
        /\b(?:you\s+can|please)\s+(?:close|end|stop)\b/,
        /\bthat answers (?:my|the) question\b/,
        /\b(?:that's|that is)\s+all\b/,
        /\b(?:we're|we are)\s+done\b/,
        /\bno\s+more\s+questions\b/
    ].some(pattern => pattern.test(text));
}

async function handleAiMessage(message) {
    clearExpiredAiConversations();

    const isMention = discord.user && message.mentions.users.has(discord.user.id);
    const key = aiConversationKey(message);
    const conversation = aiConversations.get(key);
    const repliedMessageId = message.reference?.messageId;
    const isConversationReply = conversation && conversation.botMessageIds.includes(repliedMessageId);

    if (!isMention && !isConversationReply) return false;
    const prompt = isMention
        ? message.content.replace(new RegExp(`<@!?${discord.user.id}>`, 'g'), '').trim()
        : message.content.trim();

    if (!prompt) {
        await message.reply(isMention
            ? 'Ask me a question after mentioning me. Example: `@HallKeeper explain subnetting simply`'
            : 'Reply with a follow-up question, or mention me to start a new topic.');
        return true;
    }
    if (isConversationReply && isCloseConversationRequest(prompt)) {
        aiConversations.delete(key);
        await message.reply('✅ Conversation closed. Mention me whenever you want to start a new one.');
        return true;
    }
    if (AI_CHANNEL_IDS.size > 0 && !AI_CHANNEL_IDS.has(message.channel.id)) {
        await message.reply("❌ AI questions aren't enabled in this channel.");
        return true;
    }
    if (!openai) {
        await message.reply('❌ AI replies are not configured yet. An administrator needs to add `OPENAI_API_KEY` to the bot configuration.');
        return true;
    }
    if (!canMakeAiRequest(message.author.id)) {
        await message.reply(`⏳ You can ask up to **${AI_RATE_LIMIT_MAX}** questions every **${AI_RATE_LIMIT_WINDOW_MS / 60000} minutes**. Please try again shortly.`);
        return true;
    }

    try {
        await message.channel.sendTyping();
        const response = await openai.responses.create({
            model: AI_MODEL,
            store: false,
            max_output_tokens: AI_MAX_OUTPUT_TOKENS,
            instructions: 'You are HallKeeper, a helpful Discord assistant. Give accurate, concise, friendly answers. Use Discord-friendly Markdown. Do not claim to be a server moderator or take actions in Discord. If a question needs current information, say that you cannot verify it unless a source is provided.',
            input: buildConversationPrompt(isConversationReply ? conversation : null, prompt)
        });
        const sentMessages = await sendAiReply(message, response.output_text);
        const nextConversation = isConversationReply ? conversation : {
            channelId: message.channel.id,
            userId: message.author.id,
            turns: []
        };
        nextConversation.turns.push({ prompt, reply: response.output_text });
        nextConversation.turns = nextConversation.turns.slice(-AI_CONVERSATION_MAX_TURNS);
        nextConversation.botMessageIds = sentMessages.map(sentMessage => sentMessage.id);
        nextConversation.lastActivityAt = Date.now();
        aiConversations.set(key, nextConversation);
    } catch (error) {
        console.error('AI response error:', error);
        await message.reply("❌ I couldn't answer that right now. Please try again in a moment.");
    }
    return true;
}

function getHelpMessage() {
    return `🤖 **HallKeeper — Available Commands**

### 📁 Channels & Categories
• **Create a channel**
  Example: \`Create a general channel in Gaming\`

• **Create a category**
  Example: \`Create a category called Minecraft\`

• **Delete a channel**
  Example: \`Delete the memes channel\`

• **Rename a channel**
  Example: \`Rename general to main-chat\`

• **Move a channel**
  Example: \`Move lfg to Destiny\`

• **List channels**
  Example: \`Show me all the channels\`


### 👥 Members
• **Kick a member**
  Example: \`Kick @username\`

• **Ban a member**
  Example: \`Ban @username\`

• **Mute a member**
  Example: \`Mute @username for 10 minutes\`

• **Unmute a member**
  Example: \`Unmute @username\`

• **Warn a member**
  Example: \`Warn @username for spamming\`

• **View warning history**
  Example: \`Show warnings for @username\`

• **Clear warning history**
  Example: \`Clear warnings for @username\`


### 🎭 Roles
• **Create a role**
  Example: \`Create a role called Moderator\`

• **Give someone a role**
  Example: \`Give @username the Moderator role\`

• **Remove a role**
  Example: \`Remove the Moderator role from @username\`

• **Delete a role**
  Example: \`Delete the Moderator role\`


### 💬 Messages
• **Send a message**
  Example: \`Send a message to Gaming/general saying Hello everyone!\`

• **Clear messages**
  Example: \`Clear the last 20 messages\`

• **Clear the entire chat**
  Example: \`Clear the chat\`


### 🔧 Other
• **Ask HallKeeper a question**
  Example: \`@HallKeeper explain subnetting simply\`

• **Check channel permissions**
  Example: \`Check permissions for general\`

• **Ask me what I can do**
  Example: \`What can you do?\`

💡 You can start requests with \`HallKeeper,\` and use everyday wording such as \`make\`, \`add\`, \`remove\`, \`show\`, or \`please\`—you don't need to use an exact command.`;
}

async function executeNatural(message, authorisedStaff, translationDepth = 0) {
    if (!authorisedStaff || message.content.startsWith('!')) return false;

    const text = normaliseNaturalRequest(message.content);

    // ============================================================
    // NATURAL HELP / COMMAND LIST
    // ============================================================
    if (naturalHelpRequested(text)) {
        await message.reply(getHelpMessage());
        return true;
    }

    let match;

    const namedVoiceLimits = parseNaturalNamedVoiceLimitsRequest(message.content);
    if (namedVoiceLimits) {
        if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
        const category = findCategory(message.guild, namedVoiceLimits.categoryName);
        if (!category) { await message.reply(`❌ I couldn't find a category called **${namedVoiceLimits.categoryName}**.`); return true; }
        const missing = [];
        const channels = [];
        for (const assignment of namedVoiceLimits.assignments) {
            const channel = message.guild.channels.cache.find(candidate =>
                candidate.parentId === category.id && candidate.type === ChannelType.GuildVoice && candidate.name.toLowerCase() === assignment.channelName.toLowerCase()
            );
            if (!channel) missing.push(assignment.channelName);
            else channels.push({ channel, userLimit: assignment.userLimit });
        }
        if (missing.length) { await message.reply(`❌ I couldn't find these voice channels in **${category.name}**: ${missing.map(name => `**${name}**`).join(', ')}.`); return true; }
        try {
            for (const item of channels) await item.channel.setUserLimit(item.userLimit);
            await message.reply(`✅ Updated the user limits for ${channels.length} voice channel${channels.length === 1 ? '' : 's'} in **${category.name}**.`);
        } catch (error) {
            console.error('Natural named voice limit error:', error);
            await message.reply("❌ I couldn't update those voice channel user limits. Check my permissions.");
        }
        return true;
    }

    const categoryVoiceLimit = parseNaturalCategoryVoiceLimitRequest(message.content);
    if (categoryVoiceLimit) {
        if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
        const category = findCategory(message.guild, categoryVoiceLimit.categoryName);
        if (!category) { await message.reply(`❌ I couldn't find a category called **${categoryVoiceLimit.categoryName}**.`); return true; }
        const voiceChannels = message.guild.channels.cache.filter(channel => channel.parentId === category.id && channel.type === ChannelType.GuildVoice);
        const numberedChannels = [...voiceChannels.values()].map(channel => ({
            channel,
            number: Number.parseInt(channel.name.match(/\b(\d{1,2})\b/)?.[1] || '', 10)
        })).filter(item => Number.isFinite(item.number) && item.number <= 99);
        if (numberedChannels.length === 0) { await message.reply(`❌ I couldn't find numbered voice channels inside **${category.name}**.`); return true; }
        try {
            for (const item of numberedChannels) await item.channel.setUserLimit(item.number);
            await message.reply(`✅ Set the user limits for ${numberedChannels.length} voice channel${numberedChannels.length === 1 ? '' : 's'} in **${category.name}** to their matching numbers.`);
        } catch (error) {
            console.error('Natural category voice limit error:', error);
            await message.reply("❌ I couldn't update the voice channel user limits. Check my permissions.");
        }
        return true;
    }

    const voiceLimit = parseNaturalVoiceLimitRequest(message.content);
    if (voiceLimit) {
        if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
        const channel = message.guild.channels.cache.find(candidate =>
            candidate.type === ChannelType.GuildVoice && candidate.name.toLowerCase() === voiceLimit.channelName.toLowerCase()
        );
        if (!channel) { await message.reply(`❌ I couldn't find a voice channel called **${voiceLimit.channelName}**.`); return true; }
        try {
            await channel.setUserLimit(voiceLimit.userLimit);
            await message.reply(`✅ Set **${channel.name}** to a maximum of **${voiceLimit.userLimit}** user${voiceLimit.userLimit === 1 ? '' : 's'}.`);
        } catch (error) {
            console.error('Natural voice limit error:', error);
            await message.reply("❌ I couldn't update that voice channel's user limit. Check my permissions.");
        }
        return true;
    }

    const categoryPosition = parseNaturalCategoryPositionRequest(message.content);
    if (categoryPosition) {
        if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
        const category = findCategory(message.guild, categoryPosition.categoryName);
        const reference = findCategory(message.guild, categoryPosition.referenceCategoryName);
        if (!category) { await message.reply(`❌ I couldn't find a category called **${categoryPosition.categoryName}**.`); return true; }
        if (!reference) { await message.reply(`❌ I couldn't find a category called **${categoryPosition.referenceCategoryName}**.`); return true; }
        if (category.id === reference.id) { await message.reply('❌ The category cannot be positioned relative to itself.'); return true; }
        try {
            await category.setPosition(reference.position + (categoryPosition.direction === 'below' ? 1 : 0));
            await message.reply(`✅ Moved **${category.name}** ${categoryPosition.direction} **${reference.name}**.`);
        } catch (error) {
            console.error('Natural category position error:', error);
            await message.reply("❌ I couldn't move that category. Check my permissions.");
        }
        return true;
    }

    const permissionCopy = parseNaturalPermissionCopyRequest(message.content);
    if (permissionCopy) {
        if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
        const source = findPermissionTemplateCategory(message.guild, permissionCopy.sourceCategoryName);
        const target = findCategory(message.guild, permissionCopy.targetCategoryName);
        if (!source) { await message.reply(`❌ I couldn't find a permission template category matching **${permissionCopy.sourceCategoryName}**.`); return true; }
        if (!target) { await message.reply(`❌ I couldn't find a category called **${permissionCopy.targetCategoryName}**.`); return true; }
        if (source.id === target.id) { await message.reply('❌ The source and target categories must be different.'); return true; }
        try {
            const result = await applyPermissionTemplate(target, source);
            const skippedNote = result.skipped ? ` Skipped ${result.skipped} overwrite${result.skipped === 1 ? '' : 's'} the bot cannot manage.` : '';
            await message.reply(`✅ Applied the permissions from **${source.name}** to **${target.name}** and its ${result.childChannelCount} child channel${result.childChannelCount === 1 ? '' : 's'}.${skippedNote}`);
        } catch (error) {
            console.error('Natural copy permissions error:', error);
            await message.reply("❌ I couldn't apply those permissions. Check my permissions and role hierarchy.");
        }
        return true;
    }

    const layout = parseNaturalChannelLayout(message.content);
    if (layout) {
        if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
        try {
            let category = findCategory(message.guild, layout.categoryName);
            const categoryWasCreated = !category;
            if (categoryWasCreated) category = await message.guild.channels.create({ name: layout.categoryName, type: ChannelType.GuildCategory });
            const permissionTemplate = categoryWasCreated ? findGamingPermissionTemplateCategory(message.guild) : null;
            if (permissionTemplate) await applyPermissionTemplate(category, permissionTemplate);
            for (const channelName of layout.textChannels) {
                const name = channelName.toLowerCase().replace(/\s+/g, '-');
                const existing = message.guild.channels.cache.find(channel => channel.parentId === category.id && channel.type === ChannelType.GuildText && channel.name.toLowerCase() === name);
                if (!existing) await message.guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id });
            }
            for (const voiceChannel of layout.voiceChannels) {
                const existing = message.guild.channels.cache.find(channel => channel.parentId === category.id && channel.type === ChannelType.GuildVoice && channel.name.toLowerCase() === voiceChannel.name.toLowerCase());
                if (existing) {
                    if (voiceChannel.userLimit !== null && existing.userLimit !== voiceChannel.userLimit) {
                        await existing.setUserLimit(voiceChannel.userLimit);
                    }
                } else {
                    await message.guild.channels.create({
                        name: voiceChannel.name,
                        type: ChannelType.GuildVoice,
                        parent: category.id,
                        userLimit: voiceChannel.userLimit ?? 0
                    });
                }
            }
            if (permissionTemplate) await applyPermissionTemplate(category, permissionTemplate);
            const templateNote = categoryWasCreated && permissionTemplate
                ? ` Permissions copied from **${permissionTemplate.name}**.`
                : categoryWasCreated ? ' No gaming permission template was found.' : '';
            await message.reply(`✅ Created or updated **${category.name}** with the requested text and voice channels.${templateNote}`);
        } catch (error) {
            console.error('Natural create channel layout error:', error);
            await message.reply("❌ I couldn't create that channel layout. Check my permissions.");
        }
        return true;
    }

    match = text.match(/^(?:create|make|add|set\s+up)\s+(?:a\s+)?(?:new\s+)?(?:text\s+)?channel\s+(?:called|named)?\s*(.+?)\s+(?:in|under|inside)\s+(?:the\s+)?(?:category\s+)?(.+?)(?:\s+please)?$/i);
    if (match) {
        if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
        const channelName = match[1].trim().toLowerCase().replace(/\s+/g, '-');
        const categoryName = match[2].trim();
        const category = findCategory(message.guild, categoryName);
        if (!category) {
            await message.reply(`❌ I couldn't find a category called **${categoryName}**.`);
            return true;
        }
        try {
            const channel = await message.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: category.id
            });
            await message.reply(`✅ Created ${channel} inside **${category.name}**`);
        } catch (error) {
            console.error('Natural create channel error:', error);
            await message.reply("❌ I couldn't create that channel. Check my permissions.");
        }
        return true;
    }

    match = text.match(/^(?:create|make|add|set\s+up)\s+(?:a\s+)?(?:new\s+)?(?:text\s+)?channel\s+(?:called|named)?\s*(.+?)(?:\s+please)?$/i);
    if (match) {
        if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
        const channelName = match[1].trim().toLowerCase().replace(/\s+/g, '-');
        try {
            const channel = await message.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText
            });
            await message.reply(`✅ Created ${channel}`);
        } catch (error) {
            console.error('Natural create channel error:', error);
            await message.reply("❌ I couldn't create that channel. Check my permissions.");
        }
        return true;
    }

    match = text.match(/^(?:create|make|add|set\s+up)\s+(?:a\s+)?(?:new\s+)?category\s+(?:called|named)?\s*(.+?)(?:\s+please)?$/i);
    if (match) {
        if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
        const categoryName = match[1].trim();
        try {
            const category = await message.guild.channels.create({
                name: categoryName,
                type: ChannelType.GuildCategory
            });
            await message.reply(`✅ Created category **${category.name}**`);
        } catch (error) {
            console.error('Natural create category error:', error);
            await message.reply("❌ I couldn't create that category. Check my permissions.");
        }
        return true;
    }

    if (/^(?:list|show|display)\s+(?:me\s+)?(?:all\s+)?(?:the\s+)?(?:server\s+)?channels(?:\s+please)?$/i.test(text)) {
        await sendChannelList(message);
        return true;
    }

    match = text.match(/^(?:kick|remove)\s+(.+?)(?:\s+from\s+(?:the\s+)?server)?(?:\s+please)?$/i);
    if (match) return await naturalKick(message, match[1].trim());

    match = text.match(/^(?:ban|block)\s+(.+?)(?:\s+from\s+(?:the\s+)?server)?(?:\s+please)?$/i);
    if (match) return await naturalBan(message, match[1].trim());

    match = text.match(/^(?:mute|timeout|silence)\s+(.+?)\s+(?:for\s+)?(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?:\s+please)?$/i);
    if (match) {
        const unitText = match[3].toLowerCase();
        const unit = unitText.startsWith('second') || unitText === 'sec' || unitText === 's'
            ? 's'
            : unitText.startsWith('minute') || unitText === 'min' || unitText === 'm'
                ? 'm'
                : unitText.startsWith('hour') || unitText === 'hr' || unitText === 'h'
                    ? 'h' : 'd';
        return await naturalMute(message, match[1].trim(), `${match[2]}${unit}`);
    }

    match = text.match(/^(?:unmute|untimeout|unsilence)\s+(.+?)(?:\s+please)?$/i);
    if (match) {
        return await naturalUnmute(message, match[1].trim());
    }

    match = text.match(/^(?:warn|give\s+(?:a\s+)?warning\s+to)\s+(.+?)\s+(?:for|because)\s+(.+?)(?:\s+please)?$/i);
    if (match) return await naturalWarn(message, match[1].trim(), match[2].trim());

    match = text.match(/^(?:show|list|view)\s+(?:the\s+)?warnings?\s+(?:for|of)\s+(.+?)(?:\s+please)?$/i);
    if (match) return await showWarnings(message, match[1].trim());

    match = text.match(/^(?:clear|remove|delete)\s+(?:all\s+)?warnings?\s+(?:for|from)\s+(.+?)(?:\s+please)?$/i);
    if (match) return await requestWarningClear(message, match[1].trim());

    match = text.match(/^(?:clear|delete|remove|purge)\s+(?:the\s+)?(?:last\s+)?(\d+)\s+messages?(?:\s+please)?$/i);
    if (match) return await naturalClear(message, parseInt(match[1], 10));

    if (/^(?:clear|delete|purge)\s+(?:the\s+)?(?:entire\s+|all\s+(?:the\s+)?)?(?:chat|channel|messages)(?:\s+please)?$/i.test(text)) {
        return await naturalClearAll(message);
    }

    match = text.match(/^(?:delete|remove|get\s+rid\s+of)\s+(?:the\s+)?(?:channel\s+(?:called|named)?\s*|#)(.+?)(?:\s+please)?$/i);
    if (match) return await naturalDeleteChannel(message, match[1].trim());

    match = text.match(/^(?:delete|remove|get\s+rid\s+of)\s+(?:the\s+)?(.+?)\s+channel(?:\s+please)?$/i);
    if (match) return await naturalDeleteChannel(message, match[1].trim());

    match = text.match(/^(?:rename|change(?:\s+the\s+name\s+of)?)\s+(?:the\s+)?(?:channel\s+)?#?(.+?)\s+(?:to|as)\s+(.+?)(?:\s+please)?$/i);
    if (match) return await naturalRenameChannel(message, match[1].trim(), match[2].trim());

    match = text.match(/^(?:move|put)\s+(?:the\s+)?(?:channel\s+)?#?(.+?)\s+(?:to|into|under)\s+(?:the\s+)?(?:category\s+)?(.+?)(?:\s+please)?$/i);
    if (match) return await naturalMoveChannel(message, match[1].trim(), match[2].trim());

    match = text.match(/^(?:create|make|add)\s+(?:a\s+)?(?:new\s+)?role\s+(?:called|named)?\s*(.+?)(?:\s+please)?$/i);
    if (match) return await naturalCreateRole(message, match[1].trim());

    match = text.match(/^(?:delete|remove|get\s+rid\s+of)\s+(?:the\s+)?role\s+(?:called|named)?\s*(.+?)(?:\s+please)?$/i);
    if (match) return await naturalDeleteRole(message, match[1].trim());

    match = text.match(/^(?:give|add|assign)\s+(.+?)\s+(?:the\s+)?role\s+(.+?)(?:\s+please)?$/i);
    if (match) return await naturalAddRole(message, match[1].trim(), match[2].trim());

    match = text.match(/^(?:give|add|assign)\s+(?:the\s+)?role\s+(.+?)\s+to\s+(.+?)(?:\s+please)?$/i);
    if (match) return await naturalAddRole(message, match[2].trim(), match[1].trim());

    match = text.match(/^(?:remove|take)\s+(?:the\s+)?role\s+(.+?)\s+(?:from|off)\s+(.+?)(?:\s+please)?$/i);
    if (match) return await naturalRemoveRole(message, match[2].trim(), match[1].trim());

    match = text.match(/^(?:send|post|say)\s+(?:a\s+)?message\s+(?:to|in)\s+(.+?)\/(.+?)\s+(?:saying|that\s+says)?\s*(.+)$/i);
    if (match) return await naturalSendMessage(message, match[1].trim(), match[2].trim(), match[3].trim());

    match = text.match(/^(?:send|post|say)\s+(?:a\s+)?message\s+(?:to|in)\s+#?(.+?)\s+(?:saying|that\s+says)?\s*(.+)$/i);
    if (match) return await naturalSendMessageToChannel(message, match[1].trim(), match[2].trim());

    match = text.match(/^(?:check|show|view)\s+(?:the\s+)?(?:channel\s+)?permissions\s+(?:for|of|on)\s+#?(.+?)(?:\s+please)?$/i);
    if (match) return await sendPermissionCheck(message, match[1].trim());

    const intentKey = naturalIntentKey(message);
    const hasIntentHistory = (naturalIntentHistory.get(intentKey) || []).length > 0;
    if (translationDepth === 0 && openai && (looksLikeNaturalManagementRequest(message.content) || hasIntentHistory)) {
        const history = naturalIntentHistory.get(intentKey) || [];
        history.push(message.content);
        naturalIntentHistory.set(intentKey, history.slice(-4));
        const translated = await translateNaturalRequest(message, message.content);
        if (translated?.canonicalRequest) {
            const translatedMessage = Object.create(message);
            translatedMessage.content = translated.canonicalRequest;
            return await executeNatural(translatedMessage, authorisedStaff, 1);
        }
        if (translated?.reply) {
            await message.reply(translated.reply);
            return true;
        }
    }

    return false;
}

async function sendChannelList(message) {
    const categories = message.guild.channels.cache
        .filter(c => c.type === ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position);

    let response = '📁 **Server Categories**\n\n';
    for (const [, category] of categories) {
        response += `**${category.name}**\n`;
        const channels = message.guild.channels.cache
            .filter(c => c.parentId === category.id && c.type !== ChannelType.GuildCategory)
            .sort((a, b) => a.position - b.position);
        if (channels.size === 0) response += '└─ *(no channels)*\n\n';
        else {
            for (const [, channel] of channels) response += `└─ ${channelTypeIcon(channel)} ${channel.name}\n`;
            response += '\n';
        }
    }

    const uncategorised = message.guild.channels.cache
        .filter(c => !c.parentId && c.type !== ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position);
    if (uncategorised.size > 0) {
        response += '**Uncategorised**\n';
        for (const [, channel] of uncategorised) response += `└─ ${channelTypeIcon(channel)} ${channel.name}\n`;
    }

    if (response.length <= 2000) await message.reply(response);
    else for (let i = 0; i < response.length; i += 1900) await message.channel.send(response.slice(i, i + 1900));
}

async function naturalKick(message, input) {
    try {
        const { member, count } = await findMember(message.guild, input);
        if (!member) {
            await message.reply(`❌ I searched all **${count}** server members but couldn't find **${input}**.`);
            return true;
        }
        const bot = getBotMember(message);
        if (!bot.permissions.has('KickMembers')) {
            await message.reply("❌ HallKeeper doesn't have the **Kick Members** permission.");
            return true;
        }
        if (member.id === message.author.id || member.id === bot.id) {
            await message.reply("❌ I can't kick that member.");
            return true;
        }
        if (member.roles.highest.position >= bot.roles.highest.position) {
            await message.reply("❌ I can't kick that member because of the role hierarchy.");
            return true;
        }
        const name = member.user.tag;
        await member.kick(`Kicked by ${message.author.tag} using HallKeeper`);
        await message.reply(`✅ Kicked **${name}** from the server.`);
    } catch (error) {
        console.error('Kick error:', error);
        await message.reply("❌ I couldn't kick that member. Check HallKeeper's permissions and role hierarchy.");
    }
    return true;
}

async function naturalBan(message, input) {
    try {
        const { member, count } = await findMember(message.guild, input);
        if (!member) {
            await message.reply(`❌ I searched all **${count}** server members but couldn't find **${input}**.`);
            return true;
        }
        const bot = getBotMember(message);
        if (!bot.permissions.has('BanMembers')) {
            await message.reply("❌ HallKeeper doesn't have the **Ban Members** permission.");
            return true;
        }
        if (member.id === message.author.id || member.id === bot.id || !member.bannable) {
            await message.reply("❌ I can't ban that member because of the role hierarchy or target.");
            return true;
        }
        const name = member.user.tag;
        await member.ban({ reason: `Banned by ${message.author.tag} using HallKeeper` });
        await message.reply(`🔨 **${name}** has been banned from the server.`);
    } catch (error) {
        console.error('Ban error:', error);
        await message.reply("❌ I couldn't ban that member. Check HallKeeper's permissions and role hierarchy.");
    }
    return true;
}

async function naturalMute(message, input, duration) {
    try {
        const { member } = await findMember(message.guild, input);
        if (!member) {
            await message.reply(`❌ I couldn't find **${input}** in the server.`);
            return true;
        }
        const amount = parseInt(duration, 10);
        const unit = duration.slice(-1);
        const durationMs = unit === 's' ? amount * 1000 : unit === 'm' ? amount * 60000 : unit === 'h' ? amount * 3600000 : amount * 86400000;
        const bot = getBotMember(message);
        if (!bot.permissions.has('ModerateMembers')) {
            await message.reply("❌ HallKeeper doesn't have the **Moderate Members** permission.");
            return true;
        }
        if (durationMs < 1000 || durationMs > 28 * 86400000) {
            await message.reply("❌ The timeout must be between **1 second** and **28 days**.");
            return true;
        }
        if (member.id === message.author.id || member.id === bot.id || !member.moderatable) {
            await message.reply("❌ I can't mute that member because of the target or role hierarchy.");
            return true;
        }
        await member.timeout(durationMs, `Muted by ${message.author.tag} using HallKeeper`);
        await message.reply(`🔇 **${member.user.tag}** has been muted for **${duration}**.`);
    } catch (error) {
        console.error('Mute error:', error);
        await message.reply("❌ I couldn't mute that member. Check HallKeeper's permissions and role hierarchy.");
    }
    return true;
}

async function naturalUnmute(message, input) {
    try {
        const { member } = await findMember(message.guild, input);
        if (!member) {
            await message.reply(`❌ I couldn't find **${input}** in the server.`);
            return true;
        }
        const bot = getBotMember(message);
        if (!bot.permissions.has('ModerateMembers')) {
            await message.reply("❌ HallKeeper doesn't have the **Moderate Members** permission.");
            return true;
        }
        if (member.id === message.author.id || member.id === bot.id || !member.moderatable) {
            await message.reply("❌ I can't unmute that member because of the target or role hierarchy.");
            return true;
        }
        // Use the member edit endpoint explicitly. This sends the required JSON
        // null for communication_disabled_until, which removes a timeout.
        // Calling timeout(null) is intended to do the same, but making the
        // payload explicit avoids clients/API wrappers treating null as absent.
        await member.edit({
            communicationDisabledUntil: null,
            reason: `Unmuted by ${message.author.tag} using HallKeeper`
        });
        await message.reply(`🔊 **${member.user.tag}** has been unmuted.`);
    } catch (error) {
        console.error('Unmute error:', error);
        const status = error?.status ?? error?.code;
        if (status === 403) {
            await message.reply("❌ I couldn't unmute that member because HallKeeper lacks permission or is below the member's highest role.");
        } else {
            await message.reply("❌ I couldn't unmute that member. Check HallKeeper's permissions and role hierarchy.");
        }
    }
    return true;
}

async function naturalClear(message, amount) {
    if (amount < 1 || amount > 100) {
        await message.reply('❌ You can clear between **1 and 100 messages**.');
        return true;
    }
    const bot = getBotMember(message);
    if (!bot.permissionsIn(message.channel).has('ManageMessages')) {
            await message.reply("❌ HallKeeper doesn't have the **Manage Messages** permission in this channel.");
        return true;
    }
    try {
        const deleted = await clearMessages(message.channel, amount);
        await message.channel.send(`✅ Cleared **${deleted} messages**.`).then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
    } catch (error) {
        console.error('Clear error:', error);
        await message.reply("❌ I couldn't clear the messages.");
    }
    return true;
}

async function naturalClearAll(message) {
    const bot = getBotMember(message);
    if (!bot.permissionsIn(message.channel).has('ManageMessages')) {
            await message.reply("❌ HallKeeper doesn't have the **Manage Messages** permission in this channel.");
        return true;
    }
    try {
        await message.reply('🧹 Clearing the chat...');
        const deleted = await clearAllMessages(message.channel);
        const result = await message.channel.send(`✅ Cleared **${deleted} recent messages** from ${message.channel}. Messages older than 14 days cannot be bulk deleted by Discord.`);
        setTimeout(() => result.delete().catch(() => {}), 5000);
    } catch (error) {
        console.error('Clear all error:', error);
        await message.reply("❌ I couldn't clear the chat.");
    }
    return true;
}

async function naturalDeleteChannel(message, channelName) {
    const channel = findChannel(message.guild, channelName);
    if (!channel) {
        await message.reply(`❌ I couldn't find **#${channelName}**.`);
        return true;
    }
    if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
    await message.reply(`⚠️ **Confirmation required**\n\nAre you sure you want to delete **#${channel.name}**?\n\nType \`!confirmdelete\` within 30 seconds to confirm.`);
    pendingDeletions.set(pendingKey(message), { channelId: channel.id, expires: Date.now() + 30000 });
    return true;
}

async function naturalRenameChannel(message, oldName, newName) {
    const channel = findChannel(message.guild, oldName);
    if (!channel) {
        await message.reply(`❌ I couldn't find **#${oldName}**.`);
        return true;
    }
    if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
    newName = newName.toLowerCase().replace(/\s+/g, '-');
    try {
        await channel.setName(newName);
        await message.reply(`✅ Renamed **#${oldName}** to **#${newName}**`);
    } catch (error) {
        console.error('Rename error:', error);
        await message.reply("❌ I couldn't rename that channel. Check my permissions.");
    }
    return true;
}

async function naturalMoveChannel(message, channelName, categoryName) {
    const channel = findChannel(message.guild, channelName);
    const category = findCategory(message.guild, categoryName);
    if (!channel) {
        await message.reply(`❌ I couldn't find **#${channelName}**.`);
        return true;
    }
    if (!category) {
        await message.reply(`❌ I couldn't find a category called **${categoryName}**.`);
        return true;
    }
    if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
    try {
        await channel.setParent(category.id);
        await message.reply(`✅ Moved ${channel} into **${category.name}**`);
    } catch (error) {
        console.error('Move channel error:', error);
        await message.reply("❌ I couldn't move that channel. Check my permissions.");
    }
    return true;
}

async function naturalCreateRole(message, roleName) {
    if (!await ensureGuildPermission(message, 'ManageRoles', 'Manage Roles')) return true;
    try {
        const role = await message.guild.roles.create({ name: roleName, reason: `Created by ${message.author.tag}` });
        await message.reply(`✅ Created role **${role.name}**`);
    } catch (error) {
        console.error('Create role error:', error);
        await message.reply("❌ I couldn't create that role. Check my permissions.");
    }
    return true;
}

async function naturalAddRole(message, input, roleName) {
    try {
        if (!await ensureGuildPermission(message, 'ManageRoles', 'Manage Roles')) return true;
        const { member } = await findMember(message.guild, input);
        if (!member) {
            await message.reply(`❌ I couldn't find **${input}** in the server.`);
            return true;
        }
        const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
        if (!role) {
            await message.reply(`❌ I couldn't find a role called **${roleName}**.`);
            return true;
        }
        const bot = getBotMember(message);
        if (role.managed || role.position >= bot.roles.highest.position) {
            await message.reply("❌ I can't manage that role because it is managed by Discord or above my highest role.");
            return true;
        }
        await member.roles.add(role);
        await message.reply(`✅ Added **${role.name}** to ${member}.`);
    } catch (error) {
        console.error('Add role error:', error);
        await message.reply("❌ I couldn't add that role.");
    }
    return true;
}

async function naturalRemoveRole(message, input, roleName) {
    try {
        if (!await ensureGuildPermission(message, 'ManageRoles', 'Manage Roles')) return true;
        const { member } = await findMember(message.guild, input);
        if (!member) {
            await message.reply(`❌ I couldn't find **${input}** in the server.`);
            return true;
        }
        const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
        if (!role) {
            await message.reply(`❌ I couldn't find a role called **${roleName}**.`);
            return true;
        }
        const bot = getBotMember(message);
        if (role.managed || role.position >= bot.roles.highest.position) {
            await message.reply("❌ I can't manage that role because it is managed by Discord or above my highest role.");
            return true;
        }
        await member.roles.remove(role);
        await message.reply(`✅ Removed **${role.name}** from ${member}.`);
    } catch (error) {
        console.error('Remove role error:', error);
        await message.reply("❌ I couldn't remove that role.");
    }
    return true;
}

async function naturalDeleteRole(message, roleName) {
    if (!await ensureGuildPermission(message, 'ManageRoles', 'Manage Roles')) return true;
    const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) {
        await message.reply(`❌ I couldn't find a role called **${roleName}**.`);
        return true;
    }
    if (role.managed) {
        await message.reply("❌ I can't delete a role managed by Discord.");
        return true;
    }
    if (role.position >= getBotMember(message).roles.highest.position) {
        await message.reply("❌ I can't delete that role because it is above my highest role.");
        return true;
    }
    await message.reply(`⚠️ **Confirmation required**\n\nAre you sure you want to delete **${role.name}**?\n\nType \`!confirmdeleterole\` within 30 seconds to confirm.`);
    pendingRoleDeletions.set(pendingKey(message), { roleId: role.id, expires: Date.now() + 30000 });
    return true;
}

async function naturalSendMessage(message, categoryName, channelName, text) {
    const channel = findTextChannel(message.guild, channelName, categoryName);
    if (!channel) {
        await message.reply(`❌ I couldn't find **#${channelName}** inside **${categoryName}**.`);
        return true;
    }
    if (!await ensureChannelPermission(message, channel, 'SendMessages', 'Send Messages')) return true;
    try {
        await channel.send(text);
        await message.reply(`✅ Message sent to ${channel} in **${categoryName}**`);
    } catch (error) {
        console.error('Send message error:', error);
        await message.reply("❌ I couldn't send the message. Check the channel permissions.");
    }
    return true;
}

async function naturalWarn(message, input, reason) {
    try {
        const { member } = await findMember(message.guild, input);
        if (!member) {
            await message.reply(`❌ I couldn't find **${input}** in the server.`);
            return true;
        }
        if (member.id === message.author.id || member.id === getBotMember(message).id) {
            await message.reply("❌ I can't add a warning for that member.");
            return true;
        }

        reason = reason.trim();
        if (!reason || reason.length > 300) {
            await message.reply('❌ A warning reason must be between 1 and 300 characters.');
            return true;
        }

        const count = addWarning(message.guild.id, member, message.author, reason);
        await message.reply(`⚠️ Warned ${member} for **${reason}**. They now have **${count}** warning${count === 1 ? '' : 's'}.`);
    } catch (error) {
        console.error('Warn error:', error);
        await message.reply("❌ I couldn't save that warning. The warning history was left unchanged.");
    }
    return true;
}

async function showWarnings(message, input) {
    try {
        const { member } = await findMember(message.guild, input);
        if (!member) {
            await message.reply(`❌ I couldn't find **${input}** in the server.`);
            return true;
        }

        const warnings = getWarnings(message.guild.id, member.id);
        if (warnings.length === 0) {
            await message.reply(`✅ ${member} has no recorded warnings.`);
            return true;
        }

        const recentWarnings = warnings.slice(-5).reverse();
        const lines = recentWarnings.map((warning, index) => {
            const timestamp = Math.floor(warning.createdAt / 1000);
            return `**${warnings.length - index}.** ${warning.reason}\n↳ By ${warning.moderatorTag || 'Unknown moderator'} • <t:${timestamp}:R>`;
        });
        const suffix = warnings.length > recentWarnings.length
            ? `\n\n*Showing the newest ${recentWarnings.length} of ${warnings.length} warnings.*`
            : '';
        await message.reply(`⚠️ **Warnings for ${member.user.tag}** — ${warnings.length} total\n\n${lines.join('\n\n')}${suffix}`);
    } catch (error) {
        console.error('Show warnings error:', error);
        await message.reply("❌ I couldn't retrieve that warning history.");
    }
    return true;
}

async function requestWarningClear(message, input) {
    try {
        const { member } = await findMember(message.guild, input);
        if (!member) {
            await message.reply(`❌ I couldn't find **${input}** in the server.`);
            return true;
        }

        const count = getWarnings(message.guild.id, member.id).length;
        if (count === 0) {
            await message.reply(`✅ ${member} has no recorded warnings to clear.`);
            return true;
        }

        pendingWarningClears.set(pendingKey(message), {
            memberId: member.id,
            expires: Date.now() + 30000
        });
        await message.reply(`⚠️ **Confirmation required**\n\nClear all **${count}** warning${count === 1 ? '' : 's'} for ${member}?\n\nType \`!confirmclearwarnings\` within 30 seconds to confirm.`);
    } catch (error) {
        console.error('Request warning clear error:', error);
        await message.reply("❌ I couldn't prepare that warning-history deletion.");
    }
    return true;
}

function channelTypeIcon(channel) {
    if (channel.type === ChannelType.GuildVoice) return '🔊';
    if (channel.type === ChannelType.GuildStageVoice) return '🎙️';
    if (channel.type === ChannelType.GuildAnnouncement) return '📢';
    if (channel.type === ChannelType.GuildForum) return '💬';
    return '📝';
}

async function naturalSendMessageToChannel(message, channelName, text) {
    const channel = findTextChannel(message.guild, channelName);
    if (!channel) {
        await message.reply(`❌ I couldn't find **#${channelName}**.`);
        return true;
    }
    if (!await ensureChannelPermission(message, channel, 'SendMessages', 'Send Messages')) return true;
    try {
        await channel.send(text);
        await message.reply(`✅ Message sent to ${channel}.`);
    } catch (error) {
        console.error('Send message error:', error);
        await message.reply("❌ I couldn't send the message. Check the channel permissions.");
    }
    return true;
}

async function sendPermissionCheck(message, channelName) {
    const channel = findTextChannel(message.guild, channelName);
    if (!channel) {
        await message.reply(`❌ I couldn't find **#${channelName}**.`);
        return true;
    }
    const permissions = await checkChannelPermissions(channel, getBotMember(message));
    await message.reply(
        `🔍 Permissions for **#${channel.name}**:\n\n` +
        `View Channel: ${permissions.viewChannel ? '✅' : '❌'}\n` +
        `Send Messages: ${permissions.sendMessages ? '✅' : '❌'}\n` +
        `Read History: ${permissions.readHistory ? '✅' : '❌'}\n` +
        `Manage Channels: ${permissions.manageChannels ? '✅' : '❌'}`
    );
    return true;
}

async function handleCommand(message, authorisedStaff) {
    const content = message.content.trim();
    const lower = content.toLowerCase();

    if (lower === '!help') {
        if (!authorisedStaff) return true;
        await message.reply(getHelpMessage());
        return true;
    }

    if (!authorisedStaff) {
        if (lower.startsWith('!')) {
            await message.reply("❌ You don't have permission to use that command.");
            return true;
        }
        return false;
    }

    let match;

    if (lower.startsWith('!createchannel ')) {
        if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
        const args = content.slice('!createchannel '.length).trim().split(/\s+/);
        const channelName = args.shift().toLowerCase().replace(/\s+/g, '-');
        const categoryName = args.join(' ');
        try {
            const category = categoryName ? findCategory(message.guild, categoryName) : null;
            if (categoryName && !category) {
                await message.reply(`❌ I couldn't find a category called **${categoryName}**.`);
                return true;
            }
            const channel = await message.guild.channels.create({ name: channelName, type: ChannelType.GuildText, parent: category ? category.id : null });
            await message.reply(category ? `✅ Created ${channel} inside **${category.name}**` : `✅ Created ${channel}`);
        } catch (error) {
            console.error('Create channel error:', error);
            await message.reply("❌ I couldn't create that channel. Check my permissions.");
        }
        return true;
    }

    if (lower.startsWith('!createcategory ')) {
        if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
        const name = content.slice('!createcategory '.length).trim();
        try {
            const category = await message.guild.channels.create({ name, type: ChannelType.GuildCategory });
            await message.reply(`✅ Created category **${category.name}**`);
        } catch (error) {
            console.error('Create category error:', error);
            await message.reply("❌ I couldn't create that category. Check my permissions.");
        }
        return true;
    }

    if (lower.startsWith('!deletechannel ')) return await naturalDeleteChannel(message, content.slice('!deletechannel '.length).trim());

    if (lower === '!confirmdelete') {
        const key = pendingKey(message);
        const pending = pendingDeletions.get(key);
        if (!pending) { await message.reply("❌ You don't have a pending deletion."); return true; }
        if (Date.now() > pending.expires) { pendingDeletions.delete(key); await message.reply('❌ The confirmation has expired.'); return true; }
        const channel = message.guild.channels.cache.get(pending.channelId);
        if (!channel) { pendingDeletions.delete(key); await message.reply('❌ That channel no longer exists.'); return true; }
        if (!await ensureGuildPermission(message, 'ManageChannels', 'Manage Channels')) return true;
        try {
            const name = channel.name;
            await channel.delete();
            pendingDeletions.delete(key);
            await message.reply(`✅ Deleted **#${name}**`);
        } catch (error) {
            console.error('Delete channel error:', error);
            pendingDeletions.delete(key);
            await message.reply("❌ I couldn't delete that channel.");
        }
        return true;
    }

    if (lower.startsWith('!renamechannel ')) {
        const args = content.slice('!renamechannel '.length).trim().split(/\s+/);
        if (args.length < 2) { await message.reply('Usage: `!renamechannel old-name new-name`'); return true; }
        return await naturalRenameChannel(message, args[0], args.slice(1).join('-'));
    }

    if (lower.startsWith('!movechannel ')) {
        const args = content.slice('!movechannel '.length).trim().split(/\s+/);
        if (args.length < 2) { await message.reply('Usage: `!movechannel channel-name category-name`'); return true; }
        return await naturalMoveChannel(message, args[0], args.slice(1).join(' '));
    }

    if (lower === '!listchannels' || lower.startsWith('!listchannels ')) {
        await sendChannelList(message);
        return true;
    }

    if (lower.startsWith('!createrole ')) return await naturalCreateRole(message, content.slice('!createrole '.length).trim());

    if (lower.startsWith('!addrole ')) {
        const member = message.mentions.members.first();
        if (!member) { await message.reply('Usage: `!addrole @member Role Name`'); return true; }
        const roleName = content.replace(/^!addrole\s+<@!?\d+>\s*/i, '').trim();
        return await naturalAddRole(message, member.user.tag, roleName);
    }

    if (lower.startsWith('!removerole ')) {
        const member = message.mentions.members.first();
        if (!member) { await message.reply('Usage: `!removerole @member Role Name`'); return true; }
        const roleName = content.replace(/^!removerole\s+<@!?\d+>\s*/i, '').trim();
        return await naturalRemoveRole(message, member.user.tag, roleName);
    }

    if (lower.startsWith('!deleterole ')) return await naturalDeleteRole(message, content.slice('!deleterole '.length).trim());

    if (lower === '!confirmdeleterole') {
        const key = pendingKey(message);
        const pending = pendingRoleDeletions.get(key);
        if (!pending) { await message.reply("❌ You don't have a pending role deletion."); return true; }
        if (Date.now() > pending.expires) { pendingRoleDeletions.delete(key); await message.reply('❌ The confirmation has expired.'); return true; }
        const role = message.guild.roles.cache.get(pending.roleId);
        if (!role) { pendingRoleDeletions.delete(key); await message.reply('❌ That role no longer exists.'); return true; }
        if (!await ensureGuildPermission(message, 'ManageRoles', 'Manage Roles')) return true;
        try {
            const name = role.name;
            await role.delete(`Deleted by ${message.author.tag}`);
            pendingRoleDeletions.delete(key);
            await message.reply(`✅ Deleted role **${name}**`);
        } catch (error) {
            console.error('Delete role error:', error);
            pendingRoleDeletions.delete(key);
            await message.reply("❌ I couldn't delete that role.");
        }
        return true;
    }

    if (lower.startsWith('!sendmessage ')) {
        const input = content.slice('!sendmessage '.length).trim();
        const space = input.indexOf(' ');
        if (space === -1) { await message.reply('Usage: `!sendmessage Category/channel message`'); return true; }
        const destination = input.slice(0, space);
        const text = input.slice(space + 1).trim();
        const slash = destination.indexOf('/');
        if (slash === -1) { await message.reply('Please specify category/channel.'); return true; }
        return await naturalSendMessage(message, destination.slice(0, slash), destination.slice(slash + 1), text);
    }

    if (lower.startsWith('!checkperms ')) return await sendPermissionCheck(message, content.slice('!checkperms '.length).trim().toLowerCase());

    if (lower.startsWith('!kick ')) return await naturalKick(message, content.slice('!kick '.length).trim());
    if (lower.startsWith('!ban ')) return await naturalBan(message, content.slice('!ban '.length).trim());

    if (lower.startsWith('!mute ')) {
        const input = content.slice('!mute '.length).trim();
        const muteMatch = input.match(/^(.+?)\s+(\d+)\s*([smhd])$/i);
        if (!muteMatch) { await message.reply('Usage: `!mute @member-or-name 10m`'); return true; }
        return await naturalMute(message, muteMatch[1].trim(), `${muteMatch[2]}${muteMatch[3].toLowerCase()}`);
    }

    if (lower.startsWith('!unmute ')) return await naturalUnmute(message, content.slice('!unmute '.length).trim());

    if (lower.startsWith('!warn ')) {
        const member = message.mentions.members.first();
        if (!member) { await message.reply('Usage: `!warn @member reason`'); return true; }
        const reason = content.replace(/^!warn\s+<@!?\d+>\s*/i, '').replace(/^for\s+/i, '').trim();
        if (!reason) { await message.reply('Usage: `!warn @member reason`'); return true; }
        return await naturalWarn(message, member.user.tag, reason);
    }

    if (lower.startsWith('!warnings ')) {
        const member = message.mentions.members.first();
        const input = member ? member.user.tag : content.slice('!warnings '.length).trim();
        if (!input) { await message.reply('Usage: `!warnings @member`'); return true; }
        return await showWarnings(message, input);
    }

    if (lower.startsWith('!clearwarnings ')) {
        const member = message.mentions.members.first();
        const input = member ? member.user.tag : content.slice('!clearwarnings '.length).trim();
        if (!input) { await message.reply('Usage: `!clearwarnings @member`'); return true; }
        return await requestWarningClear(message, input);
    }

    if (lower === '!confirmclearwarnings') {
        const key = pendingKey(message);
        const pending = pendingWarningClears.get(key);
        if (!pending) { await message.reply("❌ You don't have a pending warning-history deletion."); return true; }
        if (Date.now() > pending.expires) {
            pendingWarningClears.delete(key);
            await message.reply('❌ The confirmation has expired.');
            return true;
        }
        try {
            const count = clearWarnings(message.guild.id, pending.memberId);
            pendingWarningClears.delete(key);
            await message.reply(`✅ Cleared **${count}** warning${count === 1 ? '' : 's'} for <@${pending.memberId}>.`);
        } catch (error) {
            console.error('Clear warnings error:', error);
            await message.reply("❌ I couldn't clear that warning history. It was left unchanged.");
        }
        return true;
    }

    if (lower.startsWith('!clear all')) return await naturalClearAll(message);

    if (lower.startsWith('!clear ')) {
        const amount = parseInt(content.slice('!clear '.length).trim(), 10);
        if (Number.isNaN(amount)) { await message.reply('Usage: `!clear 20`'); return true; }
        return await naturalClear(message, amount);
    }

    return false;
}

discord.once('clientReady', async () => {
    console.log(`Logged in as ${discord.user.tag}`);
    await pollNews({ initialise: true });
    setInterval(() => {
        pollNews().catch(error => console.error('News polling error:', error));
    }, NEWS_POLL_INTERVAL_MS);
    console.log(`Official news relay is active; checking every ${NEWS_POLL_INTERVAL_MS / 60000} minute(s).`);
});

discord.on('messageCreate', async message => {
    console.log(`MESSAGE RECEIVED: ${message.author.tag}: ${message.content}`);

    if (message.author.bot || !message.guild) return;

    if (await handleAiMessage(message)) return;

    // The owner, Discord administrators, and configured moderator roles can use commands
    // from any text channel. AI mentions remain governed separately by AI_CHANNEL_IDS.
    const authorisedStaff = isAuthorisedStaff(message);

    // ============================================================
    // NATURAL HELP / COMMAND LIST
    // ============================================================
    // This sits directly under the access check and is restricted to authorised staff.
    if (
        authorisedStaff &&
        !message.content.startsWith('!')
    ) {
        if (naturalHelpRequested(message.content)) {
            await message.reply(getHelpMessage());
            return;
        }
    }

    try {
        if (await executeNatural(message, authorisedStaff)) return;
        await handleCommand(message, authorisedStaff);
    } catch (error) {
        console.error('MESSAGE HANDLER ERROR:', error);
        try {
            await message.reply('❌ Something went wrong while processing that command.');
        } catch (_) {}
    }
});

discord.login(process.env.DISCORD_TOKEN);
