// Ensure that we have all required environment variables
import 'dotenv/config';
import tmi from "tmi.js";
import express from "express";
import { initDatabase, getAllCommands, upsertCommand, pool, getTwitchToken, saveTwitchToken, updateTwitchToken } from "./db.js";
import crypto from "crypto";

let cachedRowsMap = new Map(); // Initialize a new Map

// Store OAuth state for CSRF protection
const oauthStates = new Map();

//listen to port
const app = express();
app.use(express.json());

let port = process.env.PORT;
if (port == null || port == "") {
  port = 3000;
}
app.listen(port);
// After setting up your Express app
app.get("/", async (req, res) => {
  // Handle OAuth callback if code/error parameters are present
  if (req.query.code || req.query.error) {
    // Redirect to callback handler
    return res.redirect(`/auth/twitch/callback?${new URLSearchParams(req.query).toString()}`);
  }
  res.send("Welcome to my Twitch bot!");
});

// Health check endpoint to verify database
app.get("/health", async (req, res) => {
  try {
    const { pool } = await import('./db.js');
    const result = await pool.query('SELECT COUNT(*) FROM subscriber_commands');
    res.json({
      status: 'ok',
      database: 'connected',
      table: 'subscriber_commands',
      rowCount: parseInt(result.rows[0].count)
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// OAuth Token Management Functions
function isTokenExpired(expiresAt) {
  if (!expiresAt) return true;
  const expiryTime = new Date(expiresAt).getTime();
  const now = Date.now();
  // Consider token expired if it expires within 5 minutes
  return expiryTime - now < 5 * 60 * 1000;
}

async function refreshAccessToken(refreshToken) {
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set in environment variables');
  }

  try {
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken, // Use new refresh token if provided, otherwise keep old one
      expires_in: data.expires_in,
    };
  } catch (error) {
    console.error('Error refreshing access token:', error);
    throw error;
  }
}

async function getValidToken() {
  try {
    const tokenData = await getTwitchToken();

    if (!tokenData) {
      return null;
    }

    // Check if token is expired
    if (isTokenExpired(tokenData.expires_at)) {
      console.log('Access token expired, refreshing...');

      if (!tokenData.refresh_token) {
        throw new Error('Token expired and no refresh token available. Please re-authenticate.');
      }

      const refreshed = await refreshAccessToken(tokenData.refresh_token);

      // Calculate new expiry time
      const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

      // Update token in database
      await updateTwitchToken(
        tokenData.username,
        refreshed.access_token,
        refreshed.refresh_token,
        expiresAt
      );

      return {
        username: tokenData.username,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: expiresAt,
      };
    }

    return tokenData;
  } catch (error) {
    console.error('Error getting valid token:', error);
    throw error;
  }
}

// OAuth Endpoints
app.get("/auth/twitch", (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const redirectUri = process.env.TWITCH_REDIRECT_URI || `http://localhost:${port}`;

  if (!clientId) {
    return res.status(500).send('TWITCH_CLIENT_ID not configured. Please set it in your .env file.');
  }

  // Generate state for CSRF protection
  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, { timestamp: Date.now() });

  // Clean up old states (older than 10 minutes)
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [key, value] of oauthStates.entries()) {
    if (value.timestamp < tenMinutesAgo) {
      oauthStates.delete(key);
    }
  }

  const scopes = 'chat:read chat:edit';
  const authUrl = `https://id.twitch.tv/oauth2/authorize?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `state=${state}`;

  res.redirect(authUrl);
});

app.get("/auth/twitch/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`
      <html>
        <body>
          <h1>Authentication Failed</h1>
          <p>Error: ${error}</p>
          <p><a href="/auth/twitch">Try again</a></p>
        </body>
      </html>
    `);
  }

  if (!code || !state) {
    return res.status(400).send(`
      <html>
        <body>
          <h1>Authentication Failed</h1>
          <p>Missing authorization code or state parameter.</p>
          <p><a href="/auth/twitch">Try again</a></p>
        </body>
      </html>
    `);
  }

  // Validate state
  if (!oauthStates.has(state)) {
    return res.status(400).send(`
      <html>
        <body>
          <h1>Authentication Failed</h1>
          <p>Invalid state parameter. This may be a CSRF attack.</p>
          <p><a href="/auth/twitch">Try again</a></p>
        </body>
      </html>
    `);
  }

  // Remove used state
  oauthStates.delete(state);

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const redirectUri = process.env.TWITCH_REDIRECT_URI || `http://localhost:${port}`;

  if (!clientId || !clientSecret) {
    return res.status(500).send(`
      <html>
        <body>
          <h1>Server Configuration Error</h1>
          <p>TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set in environment variables.</p>
        </body>
      </html>
    `);
  }

  try {
    // Exchange authorization code for tokens
    const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorText}`);
    }

    const tokenData = await tokenResponse.json();

    // Validate token and get user info
    const validateResponse = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: {
        'Authorization': `OAuth ${tokenData.access_token}`,
      },
    });

    if (!validateResponse.ok) {
      throw new Error('Token validation failed');
    }

    const userInfo = await validateResponse.json();
    const username = userInfo.login;

    // Calculate expiry time
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

    // Save token to database
    await saveTwitchToken(
      username,
      tokenData.access_token,
      tokenData.refresh_token,
      expiresAt,
      tokenData.scope?.join(' ') || ''
    );

    res.send(`
      <html>
        <body>
          <h1>Authentication Successful!</h1>
          <p>Twitch bot authenticated as: <strong>${username}</strong></p>
          <p>You can now close this window. The bot will connect automatically.</p>
          <p><a href="/auth/status">Check authentication status</a></p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send(`
      <html>
        <body>
          <h1>Authentication Error</h1>
          <p>${error.message}</p>
          <p><a href="/auth/twitch">Try again</a></p>
        </body>
      </html>
    `);
  }
});

app.get("/auth/status", async (req, res) => {
  try {
    const tokenData = await getTwitchToken();

    if (!tokenData) {
      return res.json({
        authenticated: false,
        message: 'No authentication token found. Please visit /auth/twitch to authenticate.',
      });
    }

    const isExpired = isTokenExpired(tokenData.expires_at);

    return res.json({
      authenticated: true,
      username: tokenData.username,
      expires_at: tokenData.expires_at,
      is_expired: isExpired,
      scope: tokenData.scope,
    });
  } catch (error) {
    res.status(500).json({
      authenticated: false,
      error: error.message,
    });
  }
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
// Client will be created after we have a valid token
let client = null;

// Function to initialize Twitch client with token
function initializeClient(tokenData) {
  const opts = {
    identity: {
      username: tokenData.username,
      password: `oauth:${tokenData.access_token}`,
    },
    channels: process.env.TWITCH_CHANNELS
      ? process.env.TWITCH_CHANNELS.split(",").map(c => c.trim())
      : [],
  };

  // Create a new client with our options
  client = new tmi.client(opts);

  // Register our event handlers
  client.on("message", onMessageHandler);
  client.on("connected", onConnectedHandler);

  return client;
}

// No periodic sync needed - writes are immediate to database

// Called every time a message comes in
async function onMessageHandler(target, context, msg, self) {
  let user = context.username;
  let subscriber = context.subscriber;
  const badgeInfo = context.badges;
  // Channel name is like "#channelname", so we remove the #
  const channelName = target.replace('#', '').toLowerCase();
  const isBroadcaster = badgeInfo?.broadcaster === '1' || user.toLowerCase() === channelName;
  const isMod = badgeInfo?.moderator === '1';
  const subTier = getSubscriberTier(badgeInfo);
  console.log(`User: ${user}, Sub Tier: ${subTier}, Badges:`, badgeInfo);
  console.log(user + " " + msg);

  // Debug logging for % commands
  if (msg.startsWith("%")) {
    console.log(`[DEBUG] % command detected from ${user}`);
    console.log(`[DEBUG] subscriber: ${subscriber}, broadcaster: ${isBroadcaster}, mod: ${isMod}`);
    console.log(`[DEBUG] can use command: ${subscriber || isBroadcaster || isMod}`);
  }

  const commandName = msg.trim();
  const cachedName = cachedRowsMap.get(user);

  // Allow subscribers, broadcaster, and mods to use % commands
  if (msg.startsWith("%") && (subscriber || isBroadcaster || isMod)) {
    if (!cachedName) {
      try {
        await appendRow(msg, user, subTier);
        console.log(`Row appended for ${user}: ${msg.substring(0, 50)}`);
      } catch (error) {
        console.error(`Error appending row for ${user}:`, error);
        console.error('Full error:', JSON.stringify(error, null, 2));
      }
      console.log(`* Executed ${commandName} command`);
    } else if (cachedName) {
      try {
        await updateRow(msg, user, subTier);
        console.log(`Row updated for ${user}: ${msg.substring(0, 50)}`);
      } catch (error) {
        console.error(`Error updating row for ${user}:`, error);
        console.error('Full error:', JSON.stringify(error, null, 2));
      }
      console.log(`* Executed ${commandName} command`);
    } else {
      console.log(`* Unknown command ${user + " " + commandName}`);
    }
  } else if (msg.startsWith("%")) {
    console.log(`* User ${user} tried to use % command but is not a subscriber, broadcaster, or mod`);
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

// Setup reconnection handler (will be attached when client is created)
function setupReconnectionHandlers() {
  if (!client) return;

  client.on('disconnected', (reason) => {
    console.log(`Disconnected: ${reason}`);
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      setTimeout(async () => {
        console.log(`Attempting to reconnect (${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
        try {
          // Get valid token (refresh if needed)
          const tokenData = await getValidToken();
          if (!tokenData) {
            console.error('No valid token available for reconnection');
            return;
          }

          // Recreate client with fresh token
          if (client) {
            try {
              await client.disconnect();
            } catch (e) {
              // Ignore disconnect errors
            }
          }

          initializeClient(tokenData);
          setupReconnectionHandlers();
          await client.connect();
          reconnectAttempts++;
        } catch (error) {
          console.error('Error during reconnection:', error);
        }
      }, RECONNECT_DELAY);
    } else {
      console.error('Max reconnection attempts reached. Please check your connection and restart the bot.');
    }
  });

  client.on('connected', (addr, port) => {
    console.log(`* Connected to ${addr}:${port}`);
    reconnectAttempts = 0; // Reset reconnect attempts on successful connection
  });
}

// Add error handling for the Express server
app.on('error', (error) => {
  console.error('Express server error:', error);
});

// Add graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Starting graceful shutdown...');
  try {
    // Disconnect from Twitch if client exists
    if (client) {
      await client.disconnect();
    }
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
  try {
    console.log("Starting authentication and loading...");
    await authenticateAndLoad();
    console.log("Authentication and loading completed.");

    // Get valid token from database
    console.log("Checking for Twitch authentication token...");
    const tokenData = await getValidToken();

    if (!tokenData) {
      const authUrl = `http://localhost:${port}/auth/twitch`;
      console.log("=".repeat(60));
      console.log("No Twitch authentication token found!");
      console.log("Please visit the following URL to authenticate:");
      console.log(authUrl);
      console.log("=".repeat(60));
      console.log("Bot is running and waiting for authentication...");
      return; // Don't exit, let the server run so user can authenticate
    }

    console.log(`Authenticated as: ${tokenData.username}`);

    // Initialize client with token
    initializeClient(tokenData);
    setupReconnectionHandlers();

    // Connect to Twitch after we have a valid token
    console.log("Connecting to Twitch...");
    await client.connect();
  } catch (error) {
    console.error("Fatal error during startup:", error);

    // If it's a token error, provide helpful message
    if (error.message.includes('token') || error.message.includes('authentication')) {
      const authUrl = `http://localhost:${port}/auth/twitch`;
      console.log("=".repeat(60));
      console.log("Authentication error. Please visit:");
      console.log(authUrl);
      console.log("=".repeat(60));
    }

    // Don't exit on token errors - let user authenticate via web interface
    if (!error.message.includes('token') && !error.message.includes('authentication')) {
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
