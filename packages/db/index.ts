import pg from "pg";
import { randomUUID } from "node:crypto";
import { caseSchema, type Analysis, type TraceEvent } from "@ryde/domain";
const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000
});
export async function listCases() {
  const { rows } = await pool.query(
    "SELECT c.snapshot, j.id AS run_id, j.status, j.result, j.attempts FROM cases c LEFT JOIN jobs j ON j.case_id=c.id ORDER BY c.ordinal"
  );
  return rows;
}
export async function enqueue(caseId: string) {
  // A single immutable demo run per seeded case bounds anonymous work.
  const { rows } = await pool.query(
    "INSERT INTO jobs(id, case_id) SELECT $1, id FROM cases WHERE id=$2 " +
    "ON CONFLICT(case_id) DO UPDATE SET case_id=EXCLUDED.case_id RETURNING id, status",
    [randomUUID(), caseId]
  );
  return rows[0] ?? null;
}
export async function readRun(id: string) {
  const run = await pool.query("SELECT id, case_id, status, result, attempts, created_at, finished_at FROM jobs WHERE id=$1", [id]);
  if (!run.rowCount) return null;
  const events = await pool.query("SELECT actor, action, detail, evidence_ids, attempt, created_at FROM events WHERE job_id=$1 ORDER BY seq", [id]);
  return { ...run.rows[0], events: events.rows };
}
export async function claimJob() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE jobs SET status='failed', lease_token=NULL WHERE status='running' AND lease_until < now() AND attempts >= 3");
    const { rows } = await client.query(
      "SELECT j.id, c.snapshot FROM jobs j JOIN cases c ON c.id=j.case_id " +
      "WHERE (j.status='queued' OR (j.status='running' AND j.lease_until < now())) AND j.attempts < 3 " +
      "ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1"
    );
    if (!rows.length) { await client.query("COMMIT"); return null; }
    const dispute = caseSchema.parse(rows[0].snapshot);
    const token = randomUUID();
    const updated = await client.query(
      "UPDATE jobs SET status='running', attempts=attempts+1, lease_token=$2, lease_until=now()+interval '30 seconds' WHERE id=$1 RETURNING attempts",
      [rows[0].id, token]
    );
    await client.query("COMMIT");
    return { id: rows[0].id as string, token, attempt: updated.rows[0].attempts as number, dispute };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
export async function appendEvent(id: string, token: string, event: TraceEvent) {
  const result = await pool.query(
    "INSERT INTO events(job_id, actor, action, detail, evidence_ids, attempt) " +
    "SELECT id, $3, $4, $5, $6::jsonb, attempts FROM jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until > now()",
    [id, token, event.actor, event.action, event.detail, JSON.stringify(event.evidenceIds)]
  );
  if (!result.rowCount) throw new Error("Worker lease lost");
}
export async function finishJob(id: string, token: string, analysis: Analysis) {
  const result = await pool.query(
    "UPDATE jobs SET status='completed', result=$3::jsonb, finished_at=now(), lease_token=NULL WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until > now()",
    [id, token, JSON.stringify(analysis)]
  );
  if (!result.rowCount) throw new Error("Worker lease lost");
}
export async function failJob(id: string, token: string) {
  await pool.query("UPDATE jobs SET status='failed', lease_token=NULL WHERE id=$1 AND lease_token=$2", [id, token]);
}
