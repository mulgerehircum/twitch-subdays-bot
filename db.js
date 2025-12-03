import pkg from 'pg';
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize database schema
export async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriber_commands (
        name VARCHAR(255) PRIMARY KEY,
        message TEXT NOT NULL,
        tier VARCHAR(1) NOT NULL DEFAULT '1',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriber_commands_tier 
      ON subscriber_commands(tier)
    `);
    console.log('Database schema initialized');
  } catch (error) {
    console.error('Error initializing database:', error);
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