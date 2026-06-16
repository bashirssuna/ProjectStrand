import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty, Stat } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { recheckOrgComplianceAction } from "@/app/actions";

// Financial transaction entities whose audit history this module surfaces.
const FINANCE_ENTITIES = [
  "invoice", "receipt", "payment_voucher", "expenditure", "requisition",
  "journal_entry", "statutory_remittance", "fixed_asset", "commitment",
  "bill", "purchase_order", "ledger_account",
];
const ENTITY_FILTERS: [string, string][] = [
  ["", "All transactions"], ["invoice", "Invoices"], ["receipt", "Receipts"],
  ["payment_voucher", "Payment vouchers"], ["expenditure", "Expenditures"],
  ["requisition", "Requisitions"], ["journal_entry", "Journal entries"],
  ["statutory_remittance", "Statutory remittances"], ["fixed_asset", "Assets"],
];

type Flag = { id: string; rule: string; severity: string; message: string; entity: string | null; createdAt: string; projectId: string; projectCode: string; projectTitle: string };
type Entry = { action: string; entity: string; entityId: string | null; createdAt: string; actor: string | null; before: string | null; after: string | null };

// Compact "field: a → b" (updates) or "field: value" (creates) from the JSON snapshots.
function changeSummary(before: string | null, after: string | null): string {
  const parse = (s: string | null): Record<string, unknown> => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
  const a = parse(after); const b = parse(before);
  const keys = Object.keys(a);
  if (keys.length === 0 && Object.keys(b).length === 0) return "—";
  if (Object.keys(b).length > 0) {
    return keys.map((k) => `${k}: ${b[k] ?? "∅"} → ${a[k] ?? "∅"}`).join(", ") || "updated";
  }
  return keys.map((k) => `${k}: ${a[k]}`).join(", ") || "—";
}

export default async function FinanceAuditPage({ searchParams }: { searchParams: Promise<{ entity?: string; rechecked?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;
  const entityFilter = sp.entity && FINANCE_ENTITIES.includes(sp.entity) ? sp.entity : null;

  const flags = await q<Flag>(
    `SELECT f.id, f.rule, f.severity, f.message, f.entity, f.created_at AS "createdAt",
            p.id AS "projectId", p.code AS "projectCode", p.title AS "projectTitle"
     FROM anomaly_flag f JOIN project p ON p.id=f.project_id
     WHERE p.org_id=$1 AND f.resolved=false
     ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, f.created_at DESC`, [orgId]
  );
  const crit = flags.filter((f) => f.severity === "critical").length;
  const warn = flags.filter((f) => f.severity === "warning").length;
  const info = flags.filter((f) => f.severity === "info").length;

  const audit = await q<Entry>(
    `SELECT a.action, a.entity, a.entity_id AS "entityId", a.created_at AS "createdAt", u.name AS actor, a.before, a.after
     FROM audit_log a LEFT JOIN app_user u ON u.id=a.user_id
     WHERE a.entity = ANY($1) AND a.org_id=$2 ${entityFilter ? "AND a.entity=$3" : ""}
     ORDER BY a.created_at DESC LIMIT 200`,
    entityFilter ? [FINANCE_ENTITIES, orgId, entityFilter] : [FINANCE_ENTITIES, orgId]
  );
  const approvals = audit.filter((e) => e.action === "approve").length;

  const sevTone = (s: string) => (s === "critical" ? "danger" : s === "warning" ? "warn" : "info");
  const actTone = (a: string) => (a === "create" ? "ok" : a === "delete" ? "danger" : a === "approve" ? "brand" : a === "void" ? "warn" : "info");

  return (
    <div className="max-w-5xl">
      <PageHeader title="Audit & compliance" subtitle={`Control checks and the financial audit trail · ${orgName}`}
        actions={<div className="flex gap-2">
          <form action={recheckOrgComplianceAction}><button className="btn btn-sm" type="submit">Re-run checks</button></form>
          <Link href="/finance" className="btn btn-sm">← Finance</Link>
        </div>} />
      {sp.rechecked && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Control checks re-run across all projects.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="Critical issues" value={String(crit)} sub="need attention now" tone={crit > 0 ? "danger" : "ok"} />
        <Stat label="Warnings" value={String(warn)} sub="review advised" tone={warn > 0 ? "warn" : "ok"} />
        <Stat label="Advisories" value={String(info)} sub="informational" />
        <Stat label="Approvals logged" value={String(approvals)} sub="in recent activity" />
      </div>

      {/* ---- Compliance / control checks ---- */}
      <SectionTitle>Control checks</SectionTitle>
      <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>Automated checks that test whether transactions stay within budget, post to the right line and period, carry the required approvals, and aren&apos;t duplicated.</p>
      {flags.length === 0 ? (
        <div className="card p-4 text-sm mb-6" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>No open control issues. All checked transactions are within budget, correctly posted and approved.</div>
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Severity</th><th className="th text-left">Check</th><th className="th text-left">Finding</th><th className="th text-left">Project</th><th className="th text-left">When</th></tr></thead>
            <tbody>
              {flags.map((f) => (
                <tr key={f.id}>
                  <td className="td"><Badge tone={sevTone(f.severity)}>{f.severity}</Badge></td>
                  <td className="td">{label(f.rule)}</td>
                  <td className="td">{f.message}</td>
                  <td className="td"><Link href={`/projects/${f.projectId}`} className="font-mono text-xs hover:underline" style={{ color: "var(--brand)" }}>{f.projectCode}</Link></td>
                  <td className="td whitespace-nowrap">{fmtDateTime(f.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Financial audit trail ---- */}
      <div className="flex items-center justify-between">
        <SectionTitle>Financial audit trail</SectionTitle>
        <form method="get" className="flex items-end gap-2 mb-2">
          <Field label="Filter"><select name="entity" defaultValue={entityFilter ?? ""} className="select" style={{ minWidth: 180 }}>{ENTITY_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <div className="pb-0.5"><button className="btn btn-sm" type="submit">Apply</button></div>
        </form>
      </div>
      <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>Every financial action is recorded with who did it, when, and what changed — so each transaction is traceable. Budget-line changes keep their own before/after history on each project&apos;s Budget tab.</p>
      {audit.length === 0 ? (
        <Empty title="No financial activity recorded yet" hint="Invoices, receipts, vouchers, requisitions and ledger postings will appear here as they happen." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">When</th><th className="th text-left">Who</th><th className="th text-left">Action</th><th className="th text-left">Transaction</th><th className="th text-left">Details</th></tr></thead>
            <tbody>
              {audit.map((e, i) => (
                <tr key={i}>
                  <td className="td whitespace-nowrap">{fmtDateTime(e.createdAt)}</td>
                  <td className="td">{e.actor ?? "—"}</td>
                  <td className="td"><Badge tone={actTone(e.action)}>{label(e.action)}</Badge></td>
                  <td className="td">{label(e.entity)}{e.entityId ? <span className="font-mono text-xs ml-1" style={{ color: "var(--muted)" }}>{e.entityId}</span> : null}</td>
                  <td className="td" style={{ maxWidth: 320, color: "var(--muted)" }}>{changeSummary(e.before, e.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>The audit log is append-only — entries can&apos;t be edited or deleted, which is what makes it usable as evidence in a donor or statutory audit.</p>
    </div>
  );
}
