# Twitch Subdays Bot

Node.js bot that listens to Twitch chat via `tmi.js`, lets subscribers send
a `%message`, and stores it in PostgreSQL.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file with the following variables:
```
DATABASE_URL=postgresql://user:password@localhost:5432/dbname
TWITCH_USERNAME=your_bot_username
TWITCH_OAUTH=oauth:your_oauth_token
TWITCH_CHANNELS=channel1,channel2
PORT=8000  # optional, defaults to 8000
```

3. Run the bot:
```bash
npm start
```

The database table will be created automatically on first run.
