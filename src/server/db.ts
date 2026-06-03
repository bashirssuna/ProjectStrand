import { join } from "node:path";
import { SCHEMA_SQL } from "@/server/schema";

/**
 * Dual-mode data layer.
 *  - Local dev (no DATABASE_URL): PGlite, an in-process Postgres persisted to ./.pgdata.
 *  - Production (DATABASE_URL set): a pooled `pg` connection to a managed Postgres
 *    (Neon, Supabase, Railway, Render, RDS, …). The SQL is portable across both.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const DATA_DIR = process.env.PGLITE_DIR || join(process.cwd(), ".pgdata");

type DbClient = {
  query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  exec: (sql: string) => Promise<void>;
};

type G = typeof globalThis & { __strandDb?: Promise<DbClient> };
const g = globalThis as G;

// Render *internal* DB hosts (single-label, no dot) and localhost speak plain TCP;
// public hosts (Neon, Supabase, Render external — they contain a dot) need SSL.
// Override with PGSSL=require|disable if your provider differs.
function pgSsl(url: string): false | { rejectUnauthorized: boolean } {
  const o = process.env.PGSSL;
  if (o === "disable") return false;
  if (o === "require") return { rejectUnauthorized: false };
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || !host.includes(".")) return false;
  } catch { /* fall through */ }
  return { rejectUnauthorized: false };
}

async function initPg(): Promise<DbClient> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: pgSsl(DATABASE_URL!),
    max: Number(process.env.PG_POOL_MAX || 5),
  });
  try {
    // Apply schema (idempotent: CREATE/ALTER … IF NOT EXISTS). Once per warm instance.
    if (process.env.DB_AUTO_MIGRATE !== "0") await pool.query(SCHEMA_SQL);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[db] Failed to connect/migrate Postgres:", (err as Error).message);
    throw err;
  }
  return {
    query: (sql, params) => pool.query(sql, params) as unknown as Promise<{ rows: never[] }>,
    exec: async (sql) => { await pool.query(sql); },
  };
}

async function initPglite(): Promise<DbClient> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(DATA_DIR);
  await db.waitReady;
  await db.exec(SCHEMA_SQL);
  return {
    query: (sql, params) => db.query(sql, params) as unknown as Promise<{ rows: never[] }>,
    exec: async (sql) => { await db.exec(sql); },
  };
}

export function getDb(): Promise<DbClient> {
  if (!g.__strandDb) {
    g.__strandDb = (DATABASE_URL ? initPg() : initPglite()).catch((e) => {
      g.__strandDb = undefined; // allow the next request to retry (e.g. DB waking up)
      throw e;
    });
  }
  return g.__strandDb;
}

export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await getDb();
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

export async function exec(sql: string): Promise<void> {
  const db = await getDb();
  await db.exec(sql);
}
