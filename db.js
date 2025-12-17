import pkg from 'pg';
const { Pool } = pkg;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set!');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=require') || process.env.DATABASE_URL?.includes('neon.tech')
    ? { rejectUnauthorized: false }
    : false
});

// Test connection on startup
pool.on('connect', () => {
  console.log('Database connection established');
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

// Initialize database schema
export async function initDatabase() {
  try {
    // Test connection first and get database info
    const connectionResult = await pool.query('SELECT current_database(), current_schema(), version()');
    console.log('Database connection test successful');
    console.log('Connected to database:', connectionResult.rows[0].current_database);
    console.log('Current schema:', connectionResult.rows[0].current_schema);

    // Check if table exists before creating
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'subscriber_commands'
      )
    `);
    const tableExists = tableCheck.rows[0].exists;
    console.log('Table subscriber_commands exists:', tableExists);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriber_commands (
        name VARCHAR(255) PRIMARY KEY,
        message TEXT NOT NULL,
        tier VARCHAR(1) NOT NULL DEFAULT '1',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Verify table was created
    const verifyTable = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'subscriber_commands'
      )
    `);
    console.log('Table subscriber_commands verified:', verifyTable.rows[0].exists);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriber_commands_tier 
      ON subscriber_commands(tier)
    `);

    // Create twitch_oauth_tokens table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS twitch_oauth_tokens (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at TIMESTAMP,
        scope TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_twitch_oauth_tokens_username 
      ON twitch_oauth_tokens(username)
    `);

    // List all tables in public schema
    const allTables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    console.log('All tables in public schema:', allTables.rows.map(r => r.table_name).join(', '));

    // Show table structure
    const tableColumns = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' 
      AND table_name = 'subscriber_commands'
      ORDER BY ordinal_position
    `);
    console.log('Table structure:', JSON.stringify(tableColumns.rows, null, 2));

    // Count rows
    const rowCount = await pool.query('SELECT COUNT(*) FROM subscriber_commands');
    console.log('Rows in table:', rowCount.rows[0].count);

    // If table is empty, verify it works by trying to select from it
    if (rowCount.rows[0].count === '0') {
      console.log('Table is empty - this is normal for a new database');
      console.log('Table will become visible in Neon UI once data is inserted');
    }

    console.log('Database schema initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    console.error('DATABASE_URL:', process.env.DATABASE_URL ? 'Set (hidden)' : 'NOT SET');
    throw error;
  }
}

// Get all commands from database
export async function getAllCommands() {
  const result = await pool.query(
    'SELECT name, message, tier FROM subscriber_commands'
  );
  return result.rows;
}

// Get command by name
export async function getCommandByName(name) {
  const result = await pool.query(
    'SELECT name, message, tier FROM subscriber_commands WHERE name = $1',
    [name]
  );
  return result.rows[0] || null;
}

// Insert or update command (upsert)
export async function upsertCommand(name, message, tier) {
  try {
    console.log(`[DB] upsertCommand called with: name=${name}, message=${message.substring(0, 50)}, tier=${tier}`);
    const result = await pool.query(
      `INSERT INTO subscriber_commands (name, message, tier, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (name) 
       DO UPDATE SET message = $2, tier = $3, updated_at = CURRENT_TIMESTAMP
       RETURNING name, message, tier`,
      [name, message, tier]
    );
    console.log(`[DB] upsertCommand successful, returned:`, result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error(`[DB] upsertCommand error:`, error);
    throw error;
  }
}

// Get Twitch OAuth token from database
export async function getTwitchToken() {
  try {
    const result = await pool.query(
      'SELECT username, access_token, refresh_token, expires_at, scope FROM twitch_oauth_tokens ORDER BY id DESC LIMIT 1'
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[DB] getTwitchToken error:', error);
    throw error;
  }
}

// Save Twitch OAuth token to database
export async function saveTwitchToken(username, accessToken, refreshToken, expiresAt, scope) {
  try {
    const result = await pool.query(
      `INSERT INTO twitch_oauth_tokens (username, access_token, refresh_token, expires_at, scope, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (username) 
       DO UPDATE SET 
         access_token = $2, 
         refresh_token = $3, 
         expires_at = $4, 
         scope = $5, 
         updated_at = CURRENT_TIMESTAMP
       RETURNING username, access_token, refresh_token, expires_at, scope`,
      [username, accessToken, refreshToken, expiresAt, scope]
    );
    return result.rows[0];
  } catch (error) {
    console.error('[DB] saveTwitchToken error:', error);
    throw error;
  }
}

// Update Twitch OAuth token in database
export async function updateTwitchToken(username, accessToken, refreshToken, expiresAt) {
  try {
    const result = await pool.query(
      `UPDATE twitch_oauth_tokens 
       SET access_token = $2, 
           refresh_token = COALESCE($3, refresh_token), 
           expires_at = $4, 
           updated_at = CURRENT_TIMESTAMP
       WHERE username = $1
       RETURNING username, access_token, refresh_token, expires_at, scope`,
      [username, accessToken, refreshToken, expiresAt]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[DB] updateTwitchToken error:', error);
    throw error;
  }
}