import "server-only";
import { q, one } from "@/server/db";

export type SubawardRow = {
  id: string; projectId: string | null; collaboratorId: string | null;
  granteeName: string; title: string; reference: string | null; description: string | null;
  deliverables: string | null; amount: number; currency: string;
  startDate: string | null; endDate: string | null; status: string;
  contactName: string | null; contactEmail: string | null;
  projectCode: string | null; projectTitle: string | null;
  disbursed: number; paymentCount: number;
};

const SELECT = `
  SELECT s.id, s.project_id AS "projectId", s.collaborator_id AS "collaboratorId",
         s.grantee_name AS "granteeName", s.title, s.reference, s.description, s.deliverables,
         s.amount::float AS amount, s.currency, s.start_date AS "startDate", s.end_date AS "endDate",
         s.status, s.contact_name AS "contactName", s.contact_email AS "contactEmail",
         p.code AS "projectCode", p.title AS "projectTitle",
         COALESCE((SELECT SUM(amount) FROM subaward_payment sp WHERE sp.subaward_id=s.id),0)::float AS disbursed,
         (SELECT COUNT(*) FROM subaward_payment sp WHERE sp.subaward_id=s.id)::int AS "paymentCount"
  FROM subaward s
  LEFT JOIN project p ON p.id = s.project_id`;

export async function listSubawards(orgId: string): Promise<SubawardRow[]> {
  return q<SubawardRow>(`${SELECT} WHERE s.org_id=$1 ORDER BY s.created_at DESC`, [orgId]);
}

export async function getSubaward(id: string): Promise<SubawardRow | null> {
  return one<SubawardRow>(`${SELECT} WHERE s.id=$1`, [id]);
}

export type SubawardPayment = { id: string; paidOn: string; amount: number; reference: string | null; note: string | null };
export async function listPayments(subawardId: string): Promise<SubawardPayment[]> {
  return q<SubawardPayment>(
    `SELECT id, paid_on AS "paidOn", amount::float AS amount, reference, note
     FROM subaward_payment WHERE subaward_id=$1 ORDER BY paid_on DESC, created_at DESC`, [subawardId]
  );
}

// Org-level roll-up for the Finance dashboard. Grouped by currency so awards in
// different currencies are never summed into one figure.
export type SubawardRollup = { currency: string; count: number; committed: number; disbursed: number; outstanding: number; active: number };
export async function subawardRollups(orgId: string): Promise<SubawardRollup[]> {
  const rows = await q<{ currency: string; count: number; committed: number; disbursed: number; active: number }>(
    `SELECT s.currency,
            COUNT(*)::int AS count,
            COALESCE(SUM(s.amount),0)::float AS committed,
            COALESCE(SUM((SELECT SUM(amount) FROM subaward_payment sp WHERE sp.subaward_id=s.id)),0)::float AS disbursed,
            COUNT(*) FILTER (WHERE s.status='active')::int AS active
     FROM subaward s WHERE s.org_id=$1 GROUP BY s.currency ORDER BY committed DESC`, [orgId]
  );
  return rows.map((r) => ({ ...r, outstanding: r.committed - r.disbursed }));
}
