import { queueKinds } from './sla';

/** The catalog's queue predicate (store.ts catalogQuery). The partial index (queueIndex) repeats it word for word, so the
 *  planner can use the index for the case picker's decision and handoff events instead of reading whole trails. */
export const queueEventPredicate = `event->>'kind' IN (${queueKinds.map(k => `'${k}'`).join(',')})`;
// Its own session lock, not the run-admission lock (1042042, store.ts startRun): a long build must not hold up new runs.
const indexLock = 1042043;
export const queueIndex = {
  lock: `SELECT pg_advisory_lock(${indexLock})`,
  check: "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('live_events_queue')",
  drop: 'DROP INDEX CONCURRENTLY IF EXISTS live_events_queue',
  create: `CREATE INDEX CONCURRENTLY IF NOT EXISTS live_events_queue ON live_events(run_id,seq) WHERE ${queueEventPredicate}`,
  unlock: `SELECT pg_advisory_unlock(${indexLock})`,
};
/**
 * The catalog's partial index, built without blocking writes to the trail: CONCURRENTLY, so outside any transaction,
 * as its own step after the main schema has committed (migrate.ts), one statement per query on one connection (the
 * session lock keeps a second migrator from dropping a build in progress, which also reads as invalid). An interrupted
 * build leaves an INVALID index of the same name that IF NOT EXISTS would skip: it is dropped and built again. A valid
 * index is left alone, so running it again changes nothing.
 */
export async function ensureQueueIndex(client: { query(text: string): Promise<{ rows: any[] }> }): Promise<'valid' | 'created' | 'rebuilt'> {
  await client.query(queueIndex.lock);
  try {
    const found = (await client.query(queueIndex.check)).rows[0] as { indisvalid: boolean } | undefined;
    if (found?.indisvalid) return 'valid';
    if (found) await client.query(queueIndex.drop);
    await client.query(queueIndex.create);
    return found ? 'rebuilt' : 'created';
  } finally { await client.query(queueIndex.unlock); }
}
/**
 * A table this release needs is missing (PostgreSQL 42P01, undefined table): the web started before its database step.
 * Release order: migrate (fishbowl-migrate), then the worker, then the web. The API answers with this plain message
 * instead of a storage error; nothing is created on the fly.
 */
export const migrationMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === '42P01';
export const migrationMissingMessage = 'The database step for this release has not run, so runs cannot start and past rulings cannot be read yet. Ask the operator to run the migration (fishbowl-migrate) before the worker and the web.';
export const liveSchema = `
CREATE TABLE IF NOT EXISTS live_workspaces (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE live_workspaces ADD COLUMN IF NOT EXISTS case_id text NOT NULL DEFAULT 'DISP-004';
ALTER TABLE live_workspaces ADD COLUMN IF NOT EXISTS policy_basis text NOT NULL DEFAULT 'legacy';
ALTER TABLE live_workspaces ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE live_workspaces ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE live_workspaces ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE live_workspaces ADD COLUMN IF NOT EXISTS posture jsonb;
ALTER TABLE live_workspaces ADD COLUMN IF NOT EXISTS starred_at timestamptz;
CREATE TABLE IF NOT EXISTS live_documents (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES live_workspaces(id), filename text NOT NULL,
 sha256 text NOT NULL, bytes bytea NOT NULL, source jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,sha256));
CREATE TABLE IF NOT EXISTS live_runs (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES live_workspaces(id), packet jsonb NOT NULL,
 packet_hash text NOT NULL, status text NOT NULL DEFAULT 'queued', requested text NOT NULL DEFAULT 'run',
 lease_token uuid, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz, error text,
 CHECK(status IN ('queued','running','pausing','paused','stopping','stopped','failed','completed')),
 CHECK(requested IN ('run','pause','stop')));
CREATE TABLE IF NOT EXISTS live_tasks (
 run_id uuid NOT NULL REFERENCES live_runs(id), role text NOT NULL, phase text NOT NULL,
 session_id uuid NOT NULL, status text NOT NULL, artifact jsonb, PRIMARY KEY(run_id,role,phase),
 CHECK(status IN ('running','sealed','failed','interrupted')));
CREATE TABLE IF NOT EXISTS live_events (
 run_id uuid NOT NULL REFERENCES live_runs(id), seq integer NOT NULL, event jsonb NOT NULL,
 previous_hash text NOT NULL, hash text NOT NULL, PRIMARY KEY(run_id,seq));
CREATE INDEX IF NOT EXISTS live_runs_queue ON live_runs(status,created_at);
CREATE OR REPLACE FUNCTION live_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Immutable live audit record'; END; $$;
DROP TRIGGER IF EXISTS live_events_immutable ON live_events;
CREATE TRIGGER live_events_immutable BEFORE UPDATE OR DELETE ON live_events FOR EACH ROW EXECUTE FUNCTION live_immutable();
DROP TRIGGER IF EXISTS live_documents_immutable ON live_documents;
CREATE TRIGGER live_documents_immutable BEFORE UPDATE OR DELETE ON live_documents FOR EACH ROW EXECUTE FUNCTION live_immutable();
CREATE OR REPLACE FUNCTION live_packet_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.packet IS DISTINCT FROM OLD.packet OR NEW.packet_hash IS DISTINCT FROM OLD.packet_hash THEN
 RAISE EXCEPTION 'Pinned packet cannot change'; END IF; RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS live_packet_immutable ON live_runs;
CREATE TRIGGER live_packet_immutable BEFORE UPDATE ON live_runs FOR EACH ROW EXECUTE FUNCTION live_packet_immutable();
-- Learning loop (4 October): one draft past ruling per run, from a person's override (policy/loop.ts). Approved rows join
-- the cards later runs pin at start (store.ts startRun). Never deleted; only a draft's card changes; a draft is approved or
-- rejected once; an approved card can only be withdrawn (overturned). Each action is also an event on the source run.
CREATE TABLE IF NOT EXISTS live_precedents (
 id text PRIMARY KEY, run_id uuid NOT NULL UNIQUE REFERENCES live_runs(id), status text NOT NULL DEFAULT 'draft_pending_review',
 card jsonb NOT NULL, judge jsonb NOT NULL, decision jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), reviewed_by text, review_note text,
 CHECK(status IN ('draft_pending_review','approved','rejected','overturned')));
CREATE INDEX IF NOT EXISTS live_precedents_status ON live_precedents(status,id);
-- The privacy mark (11 October 2026): who confirmed the card's text names no person's details, and when. Two row columns, not
-- part of the card, because the guard below lets only a draft's card change and an already-approved ruling is published later.
ALTER TABLE live_precedents ADD COLUMN IF NOT EXISTS privacy_checked_by text;
ALTER TABLE live_precedents ADD COLUMN IF NOT EXISTS privacy_checked_at timestamptz;
-- A mark an earlier build wrote inside the card (approvals made before this migration ran) moves onto the row once.
UPDATE live_precedents SET privacy_checked_by = card->'privacy_check'->>'confirmed_by', privacy_checked_at = (card->'privacy_check'->>'at')::timestamptz
 WHERE privacy_checked_at IS NULL AND card ? 'privacy_check' AND jsonb_typeof(card->'privacy_check'->'at') = 'string';
CREATE OR REPLACE FUNCTION live_precedent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Past rulings are never deleted; withdraw an approved card instead'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.judge IS DISTINCT FROM OLD.judge OR NEW.decision IS DISTINCT FROM OLD.decision OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'A past ruling keeps its source run and decision'; END IF;
  IF NEW.card IS DISTINCT FROM OLD.card AND OLD.status <> 'draft_pending_review' THEN RAISE EXCEPTION 'Only a draft past ruling can be edited'; END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'draft_pending_review' AND NEW.status IN ('approved','rejected')) OR (OLD.status = 'approved' AND NEW.status = 'overturned')) THEN
   RAISE EXCEPTION 'A past ruling cannot go from % to %', OLD.status, NEW.status; END IF;
  RETURN NEW;
 END; $$;
DROP TRIGGER IF EXISTS live_precedents_guard ON live_precedents;
CREATE TRIGGER live_precedents_guard BEFORE UPDATE OR DELETE ON live_precedents FOR EACH ROW EXECUTE FUNCTION live_precedent_guard();
-- Semantic index (11 October 2026, policy/semantic.ts): one Voyage vector per rule, per approved past ruling and per run's case
-- query, keyed by the text's hash so an edited card gets a new row and the old one is left behind. A cache the worker fills
-- (semantic-index.ts ensureIndex), not an audit record: the run's semantic_searched event is the record. No immutability trigger.
CREATE TABLE IF NOT EXISTS live_embeddings (
 id text PRIMARY KEY, kind text NOT NULL, ref text NOT NULL, text_sha256 text NOT NULL,
 model text NOT NULL, dimension integer NOT NULL, vector real[] NOT NULL,
 tokens integer, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(kind IN ('rule','conflict','ruling','case')));
CREATE INDEX IF NOT EXISTS live_embeddings_kind ON live_embeddings(kind, ref);
`;
