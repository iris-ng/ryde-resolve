import { pool } from "@ryde/db";
import { pool as livePool } from "../../../../../packages/live-fishbowl/connection";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await pool.query("SELECT 1 FROM schema_migrations WHERE version=1");
    let live: "ok" | "unavailable" = "ok";
    try { await livePool.query("SELECT 1 FROM live_workspaces LIMIT 1"); } catch { live = "unavailable"; }
    return Response.json({ status: "ok", mode: "simulation", live, release: process.env.RELEASE_SHA ?? "local" }, { status: live === "ok" ? 200 : 207 });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
