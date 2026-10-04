require("dotenv").config();

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType
} = require("discord.js");

const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

for (const key of ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "STAFF_ROLE_ID", "LEADERBOARD_CHANNEL_ID"]) {
  if (!process.env[key]) {
    console.error(`Missing ${key} in .env`);
    process.exit(1);
  }
}

const dataFile = process.env.DATA_FILE || config.dataFile;
const dataDir = path.dirname(path.resolve(dataFile));
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.resolve(dataFile));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS weeks (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  week_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  PRIMARY KEY (week_id, guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

function setting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, String(value));
}

function getQuota() {
  return Number(setting("weeklyQuota", config.weeklyQuota));
}

function getLeaderboardChannelId() {
  return setting("leaderboardChannelId", process.env.LEADERBOARD_CHANNEL_ID);
}

function getWeekStart(now = Date.now()) {
  const d = new Date(now);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const local = new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+09:00`);
  const day = local.getDay(); // Sunday=0
  local.setDate(local.getDate() - day);
  local.setHours(config.weeklyResetHour, config.weeklyResetMinute, 0, 0);
  if (now < local.getTime()) local.setDate(local.getDate() - 7);
  return local.getTime();
}

function weekIdFor(now = Date.now()) {
  return new Date(getWeekStart(now)).toISOString().slice(0, 19).replace(/[-:T]/g, "");
}

function ensureWeek() {
  const id = weekIdFor();
  const existing = db.prepare("SELECT id FROM weeks WHERE id=?").get(id);
  if (!existing) {
    db.prepare("INSERT INTO weeks(id,started_at) VALUES(?,?)").run(id, getWeekStart());
  }
  return id;
}

let currentWeekId = ensureWeek();

function maybeResetWeek() {
  const newId = weekIdFor();
  if (newId === currentWeekId) return false;
  const now = Date.now();
  db.prepare("UPDATE weeks SET ended_at=? WHERE id=? AND ended_at IS NULL").run(now, currentWeekId);
  db.prepare("INSERT OR IGNORE INTO weeks(id,started_at) VALUES(?,?)").run(newId, getWeekStart(now));
  currentWeekId = newId;
  return true;
}

function isStaff(member) {
  return member?.roles?.cache?.has(process.env.STAFF_ROLE_ID);
}

function increment(userId, guildId) {
  maybeResetWeek();
  db.prepare(`
    INSERT INTO messages(week_id,guild_id,user_id,count,last_message_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(week_id,guild_id,user_id)
    DO UPDATE SET count=count+1,last_message_at=excluded.last_message_at
  `).run(currentWeekId, guildId, userId, 1, Date.now());
}

function getStats(userId, guildId) {
  maybeResetWeek();
  return db.prepare("SELECT count,last_message_at FROM messages WHERE week_id=? AND guild_id=? AND user_id=?")
    .get(currentWeekId, guildId, userId) || { count: 0, last_message_at: null };
}

function getLeaderboard(guildId) {
  maybeResetWeek();
  return db.prepare(`
    SELECT user_id, count FROM messages
    WHERE week_id=? AND guild_id=?
    ORDER BY count DESC, user_id ASC
    LIMIT ?
  `).all(currentWeekId, guildId, config.leaderboardTop);
}

function color() {
  return config.embedColor || "#8B5CF6";
}

function makeLeaderboardEmbed(guild) {
  const rows = getLeaderboard(guild.id);
  const quota = getQuota();
  let body = rows.length ? rows.map((r, i) => {
    const medal = ["🥇", "🥈", "🥉"][i] || `**${i + 1}.**`;
    const member = guild.members.cache.get(r.user_id);
    const name = member ? `<@${r.user_id}>` : `<@${r.user_id}>`;
    return `${medal} ${name} — **${r.count}** / ${quota}`;
  }).join("\n") : "No staff messages recorded yet.";

  const embed = new EmbedBuilder()
    .setColor(color())
    .setTitle(config.leaderboardTitle)
    .setDescription((config.leaderboardDescription || "").replaceAll("{quota}", quota) + "\n\n" + body)
    .setFooter({ text: config.footer || "Hunter Vanity" })
    .setTimestamp();

  if (config.leaderboardBannerUrl) embed.setImage(config.leaderboardBannerUrl);
  if (config.leaderboardIconUrl) embed.setThumbnail(config.leaderboardIconUrl);
  return embed;
}

async function updateLeaderboard() {
  try {
    const channel = await client.channels.fetch(getLeaderboardChannelId());
    if (!channel || !channel.isTextBased()) return;
    const embed = makeLeaderboardEmbed(channel.guild);
    const messages = await channel.messages.fetch({ limit: 20 });
    const old = messages.find(m => m.author.id === client.user.id && m.embeds.length && m.embeds[0].title === config.leaderboardTitle);
    if (old) await old.edit({ embeds: [embed] });
    else await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error("Leaderboard update failed:", e.message);
  }
}

async function sendReminders() {
  maybeResetWeek();
  for (const [, guild] of client.guilds.cache) {
    try {
      const role = await guild.roles.fetch(process.env.STAFF_ROLE_ID);
      if (!role) continue;
      for (const [, member] of role.members) {
        if (member.user.bot) continue;
        const count = getStats(member.id, guild.id).count;
        const remaining = Math.max(getQuota() - count, 0);
        if (remaining <= 0) continue;
        const description = (config.reminderDescription || "")
          .replaceAll("{count}", count)
          .replaceAll("{quota}", getQuota())
          .replaceAll("{remaining}", remaining);
        const embed = new EmbedBuilder()
          .setColor(color())
          .setTitle(config.reminderTitle || "Staff Quota Reminder")
          .setDescription(description)
          .setFooter({ text: config.footer || "Hunter Vanity" })
          .setTimestamp();
        try { await member.send({ embeds: [embed] }); }
        catch { /* DMs closed; continue */ }
      }
    } catch (e) { console.error("Reminder failed:", e.message); }
  }
}

const commands = [
  new SlashCommandBuilder().setName("setup").setDescription("Create or update the staff leaderboard."),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Show the current staff leaderboard."),
  new SlashCommandBuilder().setName("mystats").setDescription("Show your current weekly staff stats."),
  new SlashCommandBuilder().setName("staffstats").setDescription("Show a staff member's stats.")
    .addUserOption(o => o.setName("user").setDescription("Staff member").setRequired(true)),
  new SlashCommandBuilder().setName("config").setDescription("Show the current staff quota configuration."),
  new SlashCommandBuilder().setName("setquota").setDescription("Change the weekly quota.")
    .addIntegerOption(o => o.setName("amount").setDescription("Messages per week").setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName("setreminder").setDescription("Set daily reminder time in KST.")
    .addIntegerOption(o => o.setName("hour").setDescription("0-23").setMinValue(0).setMaxValue(23).setRequired(true))
    .addIntegerOption(o => o.setName("minute").setDescription("0-59").setMinValue(0).setMaxValue(59).setRequired(true)),
  new SlashCommandBuilder().setName("setleaderboard").setDescription("Change the leaderboard channel.")
    .addChannelOption(o => o.setName("channel").setDescription("Text channel").addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName("setdesign").setDescription("Customize leaderboard appearance.")
    .addStringOption(o => o.setName("title").setDescription("Title"))
    .addStringOption(o => o.setName("description").setDescription("Description"))
    .addStringOption(o => o.setName("color").setDescription("Hex color, e.g. #8B5CF6"))
    .addStringOption(o => o.setName("banner_url").setDescription("Banner image URL"))
    .addStringOption(o => o.setName("icon_url").setDescription("Thumbnail URL"))
    .addStringOption(o => o.setName("footer").setDescription("Footer text")),
  new SlashCommandBuilder().setName("resetstats").setDescription("Reset this week's counts."),
  new SlashCommandBuilder().setName("help").setDescription("Show the bot command guide.")
].map(c => c.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
}

function admin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);\n  console.log(`Week quota: ${getQuota()} | Data file: ${path.resolve(process.env.DATA_FILE || config.dataFile)}`);
  client.user.setActivity(config.status, { type: 3 });
  await registerCommands();
  await updateLeaderboard();
  console.log("Hunter Vanity is ready.");
});

client.on("messageCreate", message => {
  if (!message.guild || message.channel.isDMBased()) return;
  if (!config.countBotMessages && message.author.bot) return;
  if (message.author.id === client.user.id) return;
  const member = message.member;
  if (!member || !isStaff(member)) return;
  increment(message.author.id, message.guild.id);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const name = interaction.commandName;
    if (["setup","setquota","setreminder","setleaderboard","setdesign","resetstats"].includes(name) && !admin(interaction)) {
      return interaction.reply({ content: "❌ You need Administrator permission to use this command.", ephemeral: true });
    }

    if (name === "setup" || name === "leaderboard") {
      return interaction.reply({ embeds: [makeLeaderboardEmbed(interaction.guild)] });
    }

    if (name === "mystats" || name === "staffstats") {
      const user = name === "mystats" ? interaction.user : interaction.options.getUser("user");
      const stats = getStats(user.id, interaction.guild.id);
      const remaining = Math.max(getQuota() - stats.count, 0);
      const embed = new EmbedBuilder()
        .setColor(color())
        .setTitle(`📊 ${user.username}'s Staff Stats`)
        .setDescription(`**Messages:** ${stats.count}/${getQuota()}\n**Remaining:** ${remaining}\n**Progress:** ${Math.min(100, Math.floor(stats.count / getQuota() * 100))}%`)
        .setThumbnail(user.displayAvatarURL())
        .setFooter({ text: config.footer || "Hunter Vanity" });
      return interaction.reply({ embeds: [embed] });
    }

    if (name === "config") {
      return interaction.reply({
        content:
          `**Hunter Vanity Configuration**\n` +
          `Staff role: <@&${process.env.STAFF_ROLE_ID}>\n` +
          `Weekly quota: **${getQuota()}**\n` +
          `Reminder: **${config.reminderHour}:${String(config.reminderMinute).padStart(2,"0")} KST**\n` +
          `Reset: **Sunday ${config.weeklyResetHour}:${String(config.weeklyResetMinute).padStart(2,"0")} KST**\n` +
          `Leaderboard: <#${getLeaderboardChannelId()}>`,
        ephemeral: true
      });
    }

    if (name === "setquota") {
      const amount = interaction.options.getInteger("amount");
      setSetting("weeklyQuota", amount);
      await interaction.reply(`✅ Weekly quota changed to **${amount} messages**.`);
      await updateLeaderboard();
      return;
    }

    if (name === "setreminder") {
      config.reminderHour = interaction.options.getInteger("hour");
      config.reminderMinute = interaction.options.getInteger("minute");
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      return interaction.reply(`✅ Daily reminder set to **${config.reminderHour}:${String(config.reminderMinute).padStart(2,"0")} KST**.`);
    }

    if (name === "setleaderboard") {
      const channel = interaction.options.getChannel("channel");
      setSetting("leaderboardChannelId", channel.id);
      await interaction.reply(`✅ Leaderboard channel changed to ${channel}.`);
      return updateLeaderboard();
    }

    if (name === "setdesign") {
      const fields = ["title","description","color","banner_url","icon_url","footer"];
      for (const f of fields) {
        const value = interaction.options.getString(f);
        if (value !== null) {
          if (f === "title") config.leaderboardTitle = value;
          if (f === "description") config.leaderboardDescription = value;
          if (f === "color") config.embedColor = value;
          if (f === "banner_url") config.leaderboardBannerUrl = value;
          if (f === "icon_url") config.leaderboardIconUrl = value;
          if (f === "footer") config.footer = value;
        }
      }
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      await interaction.reply("✅ Leaderboard design updated.");
      return updateLeaderboard();
    }

    if (name === "resetstats") {
      maybeResetWeek();
      db.prepare("DELETE FROM messages WHERE week_id=? AND guild_id=?").run(currentWeekId, interaction.guild.id);
      await interaction.reply("✅ This week's staff message counts have been reset.");
      return updateLeaderboard();
    }

    if (name === "help") {
      return interaction.reply({
        content:
          "**Hunter Vanity Staff Quota**\n" +
          "`/leaderboard` — Top staff\n" +
          "`/mystats` — Your stats\n" +
          "`/staffstats user:@member` — Staff stats\n" +
          "`/config` — Current configuration\n" +
          "`/setup` — Refresh leaderboard\n" +
          "`/setquota` — Change quota (Admin)\n" +
          "`/setreminder` — Change reminder time (Admin)\n" +
          "`/setleaderboard` — Change channel (Admin)\n" +
          "`/setdesign` — Customize leaderboard (Admin)\n" +
          "`/resetstats` — Reset current week (Admin)"
      });
    }
  } catch (e) {
    console.error(e);
    if (interaction.replied || interaction.deferred) interaction.followUp({ content: "❌ Something went wrong.", ephemeral: true }).catch(()=>{});
    else interaction.reply({ content: "❌ Something went wrong.", ephemeral: true }).catch(()=>{});
  }
});

// Check every 30 seconds for the KST reminder and weekly reset boundary.
let lastReminderKey = "";
setInterval(async () => {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(now);
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    const key = `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}`;
    maybeResetWeek();
    if (Number(p.hour) === config.reminderHour && Number(p.minute) === config.reminderMinute && key !== lastReminderKey) {
      lastReminderKey = key;
      await sendReminders();
      await updateLeaderboard();
    }
  } catch (e) { console.error("Scheduler error:", e.message); }
}, 30000);

setInterval(updateLeaderboard, Math.max(5, config.leaderboardUpdateMinutes) * 60 * 1000);

client.login(process.env.DISCORD_TOKEN);
