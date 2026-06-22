import "server-only";
import { q, one } from "@/server/db";

export type DisposalRow = {
  id: string; reference: string | null; description: string; method: string; status: string;
  estimatedValue: number; currency: string | null; proceeds: number | null; committeeName: string | null; assetName: string | null;
};

export async function listDisposals(orgId: string, f?: { status?: string; method?: string }): Promise<DisposalRow[]> {
  const where: string[] = [`d.org_id=$1`];
  const params: unknown[] = [orgId];
  let n = 2;
  if (f?.status) { where.push(`d.status=$${n}`); params.push(f.status); n++; }
  if (f?.method) { where.push(`d.method=$${n}`); params.push(f.method); n++; }
  return await q<DisposalRow>(
    `SELECT d.id, d.reference, d.description, d.method, d.status,
            d.estimated_value::float8 AS "estimatedValue", d.currency, d.proceeds::float8 AS proceeds,
            c.name AS "committeeName", a.name AS "assetName"
     FROM disposal d LEFT JOIN proc_committee c ON c.id=d.committee_id LEFT JOIN fixed_asset a ON a.id=d.asset_id
     WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC LIMIT 500`, params
  );
}

export type DisposalStats = { total: number; pending: number; disposed: number; proceeds: number };
export async function disposalStats(orgId: string): Promise<DisposalStats> {
  const rows = await q<{ status: string; c: number }>(`SELECT status, COUNT(*)::int c FROM disposal WHERE org_id=$1 GROUP BY status`, [orgId]);
  const total = rows.reduce((a, x) => a + x.c, 0);
  const disposed = rows.find((x) => x.status === "disposed")?.c ?? 0;
  const pending = rows.filter((x) => ["draft", "submitted", "board_survey", "approved"].includes(x.status)).reduce((a, x) => a + x.c, 0);
  const proceeds = (await one<{ p: number }>(`SELECT COALESCE(SUM(proceeds),0)::float8 p FROM disposal WHERE org_id=$1 AND status='disposed'`, [orgId]))?.p ?? 0;
  return { total, pending, disposed, proceeds };
}
