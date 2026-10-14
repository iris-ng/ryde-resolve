import pg from 'pg';
import { pool as appPool } from '../db';

// Hosted Fishbowl records use their own database; the existing simulation keeps
// its original DATABASE_URL. Local tests may explicitly use the shared test pool.
export const pool = process.env.FISHBOWL_DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.FISHBOWL_DATABASE_URL, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 })
  : appPool;
