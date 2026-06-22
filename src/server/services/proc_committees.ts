import "server-only";
import { q } from "@/server/db";

export type CommitteeRow = { id: string; type: string; name: string; status: string; members: number };

export async function listCommittees(orgId: string): Promise<CommitteeRow[]> {
  return await q<CommitteeRow>(
    `SELECT c.id, c.type, c.name, c.status,
            COALESCE((SELECT COUNT(*) FROM proc_committee_member m WHERE m.committee_id=c.id),0)::int AS members
     FROM proc_committee c WHERE c.org_id=$1 ORDER BY c.type, c.name`, [orgId]
  );
}

export async function committeeStats(orgId: string): Promise<{ total: number; active: number }> {
  const r = await q<{ status: string; c: number }>(`SELECT status, COUNT(*)::int c FROM proc_committee WHERE org_id=$1 GROUP BY status`, [orgId]);
  const total = r.reduce((a, x) => a + x.c, 0);
  const active = r.find((x) => x.status === "active")?.c ?? 0;
  return { total, active };
}
