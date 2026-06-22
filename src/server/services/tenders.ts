import "server-only";
import { q, one } from "@/server/db";

export type TenderRow = {
  id: string; reference: string | null; title: string; method: string; category: string; status: string;
  estimatedValue: number; currency: string | null; committeeName: string | null; bidCount: number; awardBidId: string | null; closingDate: string | null;
};

export async function listTenders(orgId: string, f?: { status?: string; method?: string; category?: string; search?: string }): Promise<TenderRow[]> {
  const where: string[] = [`t.org_id=$1`];
  const params: unknown[] = [orgId];
  let n = 2;
  if (f?.status) { where.push(`t.status=$${n}`); params.push(f.status); n++; }
  if (f?.method) { where.push(`t.method=$${n}`); params.push(f.method); n++; }
  if (f?.category) { where.push(`t.category=$${n}`); params.push(f.category); n++; }
  if (f?.search) { where.push(`(t.title ILIKE $${n} OR t.reference ILIKE $${n})`); params.push(`%${f.search}%`); n++; }
  return await q<TenderRow>(
    `SELECT t.id, t.reference, t.title, t.method, t.category, t.status, t.estimated_value::float8 AS "estimatedValue", t.currency,
            c.name AS "committeeName", t.award_bid_id AS "awardBidId", t.closing_date::text AS "closingDate",
            COALESCE((SELECT COUNT(*) FROM tender_bid b WHERE b.tender_id=t.id),0)::int AS "bidCount"
     FROM tender t LEFT JOIN proc_committee c ON c.id=t.committee_id
     WHERE ${where.join(" AND ")} ORDER BY t.created_at DESC LIMIT 500`, params
  );
}

export type BidRow = { id: string; bidderName: string; vendorName: string | null; bidAmount: number; currency: string | null; receivedDate: string | null; status: string; score: number | null; notes: string | null };
export async function tenderBids(tenderId: string): Promise<BidRow[]> {
  return await q<BidRow>(
    `SELECT b.id, b.bidder_name AS "bidderName", v.name AS "vendorName", b.bid_amount::float8 AS "bidAmount", b.currency,
            b.received_date::text AS "receivedDate", b.status, b.evaluation_score::float8 AS score, b.evaluation_notes AS notes
     FROM tender_bid b LEFT JOIN vendor v ON v.id=b.vendor_id WHERE b.tender_id=$1 ORDER BY b.bid_amount ASC`, [tenderId]
  );
}

// Lowest responsive/shortlisted bid amount (common evaluation reference).
export async function lowestResponsiveBid(tenderId: string): Promise<number | null> {
  const r = await one<{ a: number }>(`SELECT MIN(bid_amount)::float8 a FROM tender_bid WHERE tender_id=$1 AND status IN ('responsive','shortlisted','awarded')`, [tenderId]);
  return r?.a ?? null;
}

export type TenderStats = { total: number; open: number; evaluation: number; awarded: number };
export async function tenderStats(orgId: string): Promise<TenderStats> {
  const rows = await q<{ status: string; c: number }>(`SELECT status, COUNT(*)::int c FROM tender WHERE org_id=$1 GROUP BY status`, [orgId]);
  const total = rows.reduce((a, x) => a + x.c, 0);
  const open = rows.filter((x) => ["advertised", "closed"].includes(x.status)).reduce((a, x) => a + x.c, 0);
  const evaluation = rows.find((x) => x.status === "evaluation")?.c ?? 0;
  const awarded = rows.find((x) => x.status === "awarded")?.c ?? 0;
  return { total, open, evaluation, awarded };
}
