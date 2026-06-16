import "server-only";
import { q } from "@/server/db";

// Financial transaction entities whose audit history the Audit & Compliance module surfaces.
export const FINANCE_ENTITIES = [
  "invoice", "receipt", "payment_voucher", "expenditure", "requisition",
  "journal_entry", "statutory_remittance", "fixed_asset", "commitment",
  "bill", "purchase_order", "ledger_account",
];
export const ENTITY_FILTERS: [string, string][] = [
  ["", "All transactions"], ["invoice", "Invoices"], ["receipt", "Receipts"],
  ["payment_voucher", "Payment vouchers"], ["expenditure", "Expenditures"],
  ["requisition", "Requisitions"], ["journal_entry", "Journal entries"],
  ["statutory_remittance", "Statutory remittances"], ["fixed_asset", "Assets"],
];

export type AuditFilters = { entity?: string | null; projectId?: string | null; from?: string | null; to?: string | null };
export type AuditEntry = { action: string; entity: string; entityId: string | null; createdAt: string; actor: string | null; before: string | null; after: string | null; projectId: string | null; projectCode: string | null };
export type Flag = { id: string; rule: string; severity: string; message: string; entity: string | null; createdAt: string; projectId: string; projectCode: string; projectTitle: string };

// Compact "field: a → b" (updates) or "field: value" (creates) from the JSON snapshots.
export function changeSummary(before: string | null, after: string | null): string {
  const parse = (s: string | null): Record<string, unknown> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
  const a = parse(after); const b = parse(before);
  const keys = Object.keys(a);
  if (keys.length === 0 && Object.keys(b).length === 0) return "—";
  if (Object.keys(b).length > 0) return keys.map((k) => `${k}: ${b[k] ?? "∅"} → ${a[k] ?? "∅"}`).join(", ") || "updated";
  return keys.map((k) => `${k}: ${a[k]}`).join(", ") || "—";
}

// The financial audit trail, org-scoped, with each entry resolved to its project
// (where the entity is project-scoped) and optional entity/project/date filters.
export async function financeAuditTrail(orgId: string, f: AuditFilters, limit = 300): Promise<AuditEntry[]> {
  const params: unknown[] = [FINANCE_ENTITIES, orgId];
  let where = `a.entity = ANY($1) AND a.org_id=$2`;
  if (f.entity && FINANCE_ENTITIES.includes(f.entity)) { params.push(f.entity); where += ` AND a.entity=$${params.length}`; }
  if (f.from) { params.push(f.from); where += ` AND a.created_at >= $${params.length}::date`; }
  if (f.to) { params.push(f.to); where += ` AND a.created_at < ($${params.length}::date + interval '1 day')`; }
  if (f.projectId) { params.push(f.projectId); where += ` AND pr.id=$${params.length}`; }
  const lim = Math.min(Math.max(1, Math.floor(limit)), 10000);
  return q<AuditEntry>(
    `SELECT a.action, a.entity, a.entity_id AS "entityId", a.created_at AS "createdAt", u.name AS actor, a.before, a.after,
            pr.id AS "projectId", pr.code AS "projectCode"
     FROM audit_log a
     LEFT JOIN app_user u ON u.id=a.user_id
     LEFT JOIN project pr ON pr.id = COALESCE(
       (SELECT project_id FROM requisition WHERE id=a.entity_id),
       (SELECT project_id FROM expenditure WHERE id=a.entity_id),
       (SELECT project_id FROM payment_voucher WHERE id=a.entity_id OR number=a.entity_id),
       (SELECT project_id FROM invoice WHERE id=a.entity_id OR number=a.entity_id)
     )
     WHERE ${where}
     ORDER BY a.created_at DESC LIMIT ${lim}`, params
  );
}

// Open (unresolved) financial control flags across all projects in the org.
export async function complianceFlags(orgId: string): Promise<Flag[]> {
  return q<Flag>(
    `SELECT f.id, f.rule, f.severity, f.message, f.entity, f.created_at AS "createdAt",
            p.id AS "projectId", p.code AS "projectCode", p.title AS "projectTitle"
     FROM anomaly_flag f JOIN project p ON p.id=f.project_id
     WHERE p.org_id=$1 AND f.resolved=false
     ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, f.created_at DESC`, [orgId]
  );
}
