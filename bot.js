// Ensure that we have all required environment variables
import 'dotenv/config';
import tmi from "tmi.js";
import express from "express";
import { initDatabase, getAllCommands, upsertCommand, pool } from "./db.js";

let cachedRowsMap = new Map(); // Initialize a new Map

//listen to port
const app = express();

let port = process.env.PORT;
if (port == null || port == "") {
  port = 8000;
}
app.listen(port);
// After setting up your Express app
app.get("/", (req, res) => {
  res.send("Welcome to my Twitch bot!");
});

// Load commands from database into cache
async function authenticateAndLoad() {
  await initDatabase(); // Initialize database schema
  await cacheRows(); // Cache rows from database
}

async function cacheRows() {
  try {
    const rows = await getAllCommands();
    for (const row of rows) {
      cachedRowsMap.set(row.name, {
        value: row.message,
        tier: row.tier || "1", // Default to tier 1 if not set
      });
    }
    console.log(`Loaded ${rows.length} commands into cache`);
  } catch (error) {
    console.error("Error caching rows:", error);
  }
}

// Function to determine subscriber tier
function getSubscriberTier(badgeInfo) {
  if (!badgeInfo || !badgeInfo.subscriber) return "1";
  const subVersion = parseInt(badgeInfo.subscriber);
  if (subVersion >= 3000) return "3";
  if (subVersion >= 2000) return "2";
  return "1";
}

// Insert or update command in database and cache
async function appendRow(text, target, tier) {
  try {
    const result = await upsertCommand(target, text, tier);
    cachedRowsMap.set(target, {
      value: result.message,
      tier: result.tier,
    });
  } catch (error) {
    console.error("Error appending row:", error);
    throw error;
  }
}

async function updateRow(text, target, tier) {
  try {
    const result = await upsertCommand(target, text, tier);
    cachedRowsMap.set(target, {
      value: result.message,
      tier: result.tier,
    });
  } catch (error) {
    console.error("Error updating row:", error);
    throw error;
  }
}

//dictionary of users
// Define configuration options
const opts = {
  identity: {
    username: process.env.TWITCH_USERNAME,
    password: process.env.TWITCH_OAUTH,
  },
  channels: process.env.TWITCH_CHANNELS
    ? process.env.TWITCH_CHANNELS.split(",").map(c => c.trim())
    : [],
};


// Create a client with our options
const client = new tmi.client(opts);


// Register our event handlers (defined below)
client.on("message", onMessageHandler);
client.on("connected", onConnectedHandler);

// Connect to Twitch:
client.connect();

// No periodic sync needed - writes are immediate to database

// Called every time a message comes in
async function onMessageHandler(target, context, msg, self) {
  let user = context.username;
  let subscriber = context.subscriber;
  const badgeInfo = context.badges;
  const subTier = getSubscriberTier(badgeInfo);
  console.log(`User: ${user}, Sub Tier: ${subTier}, Badges:`, badgeInfo);
  console.log(user + " " + msg);
  const commandName = msg.trim();
  const cachedName = cachedRowsMap.get(user);

  if (msg.startsWith("%") && subscriber) {
    if (!cachedName) {
      try {
        await appendRow(msg, user, subTier);
        console.log("Row appended.");
      } catch (error) {
        console.error("Error appending row:", error);
      }
      console.log(`* Executed ${commandName} command`);
    } else if (cachedName) {
      try {
        await updateRow(msg, user, subTier);
        console.log("Row updated.");
      } catch (error) {
        console.error("Error updating row:", error);
      }
      console.log(`* Executed ${commandName} command`);
    } else {
      console.log(`* Unknown command ${user + " " + commandName}`);
    }
  }
}

// Called every time the bot connects to Twitch chat
function onConnectedHandler(addr, port) {
  console.log(`* Connected to ${addr}:${port}`);
}

// Add reconnection logic
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000; // 5 seconds

client.on('disconnected', (reason) => {
  console.log(`Disconnected: ${reason}`);
  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    setTimeout(() => {
      console.log(`Attempting to reconnect (${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
      client.connect();
      reconnectAttempts++;
    }, RECONNECT_DELAY);
  } else {
    console.error('Max reconnection attempts reached. Please check your connection and restart the bot.');
  }
});

client.on('connected', (addr, port) => {
  console.log(`* Connected to ${addr}:${port}`);
  reconnectAttempts = 0; // Reset reconnect attempts on successful connection
});

// Add error handling for the Express server
app.on('error', (error) => {
  console.error('Express server error:', error);
});

// Add graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Starting graceful shutdown...');
  try {
    // Disconnect from Twitch
    await client.disconnect();
    // Close database pool
    await pool.end();
    console.log('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

async function main() {
  console.log("Starting authentication and loading...");
  await authenticateAndLoad().catch((error) =>
    console.error("Error in authenticateAndLoad:", error)
  );
  console.log("Authentication and loading completed.");
}

main().catch(console.error);
