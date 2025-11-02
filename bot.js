// Ensure that we have all required environment variables
const tmi = require("tmi.js");
const dotenv = require("dotenv").config();
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
let needsSync = false; // Track if the cache needs to be synced
let cachedRowsMap = new Map(); // Initialize a new Map
let lastSyncTime = Date.now();
const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes
// Create JWT client for Google authentication
const serviceAccountAuth = new JWT({
  email: process.env.client_email,
  key: process.env.private_key.replace(/\\n/g, "\n"), // Ensure correct key format
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
//listen to port
const express = require("express");
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

// Instantiate GoogleSpreadsheet with sheet ID and auth client
const doc = new GoogleSpreadsheet(
  process.env.SHEET_ID,
  serviceAccountAuth
);

// Cache rows for faster access
async function authenticateAndLoad() {
  await doc.loadInfo(); // Load the document properties and worksheets
  await cacheRows(); // Cache rows after loading the document
}

async function cacheRows() {
  const sheet = doc.sheetsByIndex[1]; // Access the second sheet
  const rows = await sheet.getRows(); // Get rows from the sheet
  for (const row of rows) {
    // Use rowNumber as the key and an object with name, message, and tier as the value
    cachedRowsMap.set(row.get("name"), {
      value: row.get("message"),
      tier: row.get("tier") || "1", // Default to tier 1 if not set
      row: row.rowNumber,
    });
  }
}
//sync cache with sheet
async function syncCache() {
  try {
    const sheet = doc.sheetsByIndex[1];
    const rows = await sheet.getRows();

    // Only get rows that have changed
    const changes = [];
    for (let [name, cachedRow] of cachedRowsMap) {
      const existingRow = rows.find(row => row.get("name") === name);
      if (!existingRow) {
        changes.push({
          type: 'add',
          name,
          value: cachedRow.value,
          tier: cachedRow.tier
        });
      } else if (existingRow.get("message") !== cachedRow.value ||
        existingRow.get("tier") !== cachedRow.tier) {
        changes.push({
          type: 'update',
          row: existingRow,
          value: cachedRow.value,
          tier: cachedRow.tier
        });
      }
    }

    // Batch process changes
    for (const change of changes) {
      if (change.type === 'add') {
        await sheet.addRow({
          name: change.name,
          message: change.value,
          tier: change.tier
        });
      } else if (change.type === 'update') {
        change.row.set("message", change.value);
        change.row.set("tier", change.tier);
        await change.row.save();
      }
    }

    needsSync = false;
    console.log(`Sync completed successfully. Processed ${changes.length} changes.`);
  } catch (error) {
    console.error("Error syncing cache:", error);
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

//append row to the sheet
async function appendRow(text, target, tier) {
  try {
    cachedRowsMap.set(target, {
      value: text,
      tier: tier,
      row: cachedRowsMap.size + 1
    });
    needsSync = true;
  } catch (error) {
    console.error("Error appending row:", error);
  }
}

async function updateRow(text, target, tier) {
  cachedRowsMap.set(target, {
    value: text,
    tier: tier
  });
  needsSync = true;
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

// Add periodic sync function
async function periodicSync() {
  if (needsSync && (Date.now() - lastSyncTime) > SYNC_INTERVAL) {
    await syncCache();
    lastSyncTime = Date.now();
  }
}

// Start periodic sync
setInterval(periodicSync, SYNC_INTERVAL);

// Called every time a message comes in
function onMessageHandler(target, context, msg, self) {
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
        cacheRows[target] = { value: msg };
        appendRow(msg, user, subTier).then(() => console.log("Row appended."));
      } catch (error) {
        console.error("Error appending row:", error);
      }
      console.log(`* Executed ${commandName} command`);
    } else if (cachedName) {
      updateRow(msg, user, subTier).then(() => console.log("Row updated."));
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
    // Sync any pending changes
    if (needsSync) {
      await syncCache();
    }
    // Disconnect from Twitch
    await client.disconnect();
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
