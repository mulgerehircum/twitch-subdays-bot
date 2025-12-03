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

    // List all tables in public schema
    const allTables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    console.log('All tables in public schema:', allTables.rows.map(r => r.table_name).join(', '));

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
  const result = await pool.query(
    `INSERT INTO subscriber_commands (name, message, tier, updated_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (name) 
     DO UPDATE SET message = $2, tier = $3, updated_at = CURRENT_TIMESTAMP
     RETURNING name, message, tier`,
    [name, message, tier]
  );
  return result.rows[0];
}