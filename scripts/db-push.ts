/**
 * Applies the schema to the database in DATABASE_URL (production migrate).
 * Usage:  DATABASE_URL=postgres://... npm run db:push
 */
import { SCHEMA_SQL } from "../src/server/schema";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is required for db:push"); process.exit(1); }
  const { Pool } = await import("pg");
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } });
  await pool.query(SCHEMA_SQL);
  await pool.end();
  console.log("Schema applied to", url.replace(/:[^:@/]+@/, ":****@"));
}
main().catch((e) => { console.error(e); process.exit(1); });
