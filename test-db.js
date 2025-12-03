import 'dotenv/config';
import { pool } from './db.js';

async function main() {
    const result = await pool.query('SELECT now()');
    console.log('DB OK:', result.rows[0]);
    await pool.end();
}

main().catch(console.error);