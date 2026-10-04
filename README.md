# Vanity Bot Quota — Railway Ready

This is the **mobile-friendly** version of the Hunter Vanity staff message quota bot.

## IMPORTANT: GitHub upload structure

Because you are uploading from a phone, this version intentionally keeps the main bot file in the ROOT.

Your GitHub repository should look EXACTLY like this:

```text
📄 index.js
📄 package.json
📄 config.json
📄 .env.example
📄 .gitignore
📄 README.md
📄 RAILWAY_MOBILE_GUIDE.md
📄 data/.gitkeep
```

There must NOT be another folder containing all of these files.

## What NOT to upload

Do NOT upload:

- this ZIP file itself
- your real `.env` file
- your Discord bot token
- `node_modules`

## Bot settings

- Bot: Hunter Vanity
- Staff role ID: `1550437605601054720`
- Weekly quota: 200 messages
- Counts messages in accessible server channels
- Counts bot/webhook messages
- Counts thread messages
- Reminder: 9:00 PM KST
- Reminder only for staff who still need messages
- Leaderboard channel ID: `1556219681273290752`
- Leaderboard: Top 20
- Leaderboard update: every hour
- Weekly reset: Sunday at 9:00 PM KST
- Persistent SQLite statistics

## Railway start command

Railway should use:

```text
npm start
```

No custom build command is needed.

## Railway Variables

Add these in Railway → Variables:

```text
DISCORD_TOKEN=YOUR_ACTUAL_BOT_TOKEN
CLIENT_ID=YOUR_APPLICATION_ID
GUILD_ID=1550365493884616788
STAFF_ROLE_ID=1550437605601054720
LEADERBOARD_CHANNEL_ID=1556219681273290752
DATA_FILE=/app/data/staff_quota.sqlite
```

Never put the real token in GitHub.

## Persistent database

Create a Railway Volume and set its mount path to:

```text
/app/data
```

Then keep:

```text
DATA_FILE=/app/data/staff_quota.sqlite
```

This lets the SQLite database live on the Volume instead of the temporary service filesystem.

## Discord Developer Portal

Enable:

- Message Content Intent
- Server Members Intent

Invite the bot with:

- `bot`
- `applications.commands`

Recommended permissions:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Use Application Commands

## Slash commands

```text
/setup
/leaderboard
/mystats
/staffstats user:@Member
/config
/setquota amount:200
/setreminder hour:21 minute:0
/setleaderboard channel:#staff-quota
/setdesign ...
/resetstats
/help
```
