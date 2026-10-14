import { pool } from './connection';
import { ensureQueueIndex, liveSchema } from './schema';
const client = await pool.connect();
try {
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1042042)');
    await client.query(liveSchema);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  // After the commit, on its own: CREATE INDEX CONCURRENTLY cannot run in a transaction, and it lets the trail take writes.
  const index = await ensureQueueIndex(client);
  console.log(`Live Fishbowl tables ready (queue index ${index}). Existing simulation records are unchanged.`);
} finally { client.release(); await pool.end(); }
