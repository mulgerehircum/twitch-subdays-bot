# Twitch Subdays Bot

Node.js bot that listens to Twitch chat via `tmi.js`, lets subscribers send
a `%message`, caches it, and periodically syncs it to Google Sheets.

All secrets are provided via `.env`. See `.env.example`.

## Setup

```bash
npm install
cp .env.example .env   # or create .env yourself
node bot.js
