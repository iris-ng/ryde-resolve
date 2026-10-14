import { pool } from "./index";
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(7242026)");
  await client.query([
    "CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());",
    "CREATE TABLE IF NOT EXISTS cases(id text PRIMARY KEY, ordinal integer NOT NULL, snapshot jsonb NOT NULL);",
    "CREATE TABLE IF NOT EXISTS jobs(id uuid PRIMARY KEY, case_id text NOT NULL UNIQUE REFERENCES cases(id),",
    "status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),",
    "attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,",
    "result jsonb, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz);",
    "CREATE TABLE IF NOT EXISTS events(seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs(id),",
    "actor text NOT NULL, action text NOT NULL, detail text NOT NULL,",
    "evidence_ids jsonb NOT NULL DEFAULT '[]', attempt integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now());",
    "CREATE INDEX IF NOT EXISTS events_job_idx ON events(job_id, seq);",
    "INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;"
  ].join("\n"));
  await client.query("INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING");
  await client.query("INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING");
  await client.query("COMMIT");
  console.log("Schema v3 ready.");
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Migration failed", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
} finally { client.release(); await pool.end(); }
