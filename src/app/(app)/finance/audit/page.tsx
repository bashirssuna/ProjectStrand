import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty, Stat } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { recheckOrgComplianceAction } from "@/app/actions";
import { financeAuditTrail, complianceFlags, changeSummary, ENTITY_FILTERS, type AuditFilters } from "@/server/services/finance_audit";

export default async function FinanceAuditPage({ searchParams }: { searchParams: Promise<{ entity?: string; project?: string; from?: string; to?: string; rechecked?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;
  const filters: AuditFilters = { entity: sp.entity || null, projectId: sp.project || null, from: sp.from || null, to: sp.to || null };

  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [orgId]);
  const flags = await complianceFlags(orgId);
  const audit = await financeAuditTrail(orgId, filters, 300);

  const crit = flags.filter((f) => f.severity === "critical").length;
  const warn = flags.filter((f) => f.severity === "warning").length;
  const info = flags.filter((f) => f.severity === "info").length;
  const approvals = audit.filter((e) => e.action === "approve").length;

  // Carry the active filters onto the Print / Export links.
  const qs = new URLSearchParams();
  if (filters.entity) qs.set("entity", filters.entity);
  if (filters.projectId) qs.set("project", filters.projectId);
  if (filters.from) qs.set("from", filters.from);
  if (filters.to) qs.set("to", filters.to);
  const query = qs.toString() ? `?${qs.toString()}` : "";
  const filtered = Boolean(filters.entity || filters.projectId || filters.from || filters.to);

  const sevTone = (s: string) => (s === "critical" ? "danger" : s === "warning" ? "warn" : "info");
  const actTone = (a: string) => (a === "create" ? "ok" : a === "delete" ? "danger" : a === "approve" ? "brand" : a === "void" ? "warn" : "info");

  return (
    <div className="max-w-6xl">
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionTitle>Financial audit trail</SectionTitle>
        <div className="flex items-center gap-2 mb-2">
          <a href={`/print/finance-audit${query}`} target="_blank" rel="noopener" className="btn btn-sm">Print</a>
          <a href={`/api/finance/audit/export${query}`} className="btn btn-sm">Export XLSX</a>
        </div>
      </div>

      <form method="get" className="card p-3 mb-3 flex flex-wrap items-end gap-3">
        <Field label="Transaction type"><select name="entity" defaultValue={filters.entity ?? ""} className="select" style={{ minWidth: 170 }}>{ENTITY_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Project"><select name="project" defaultValue={filters.projectId ?? ""} className="select" style={{ minWidth: 170 }}><option value="">All projects</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.title}</option>)}</select></Field>
        <Field label="From"><input type="date" name="from" defaultValue={filters.from ?? ""} className="input" /></Field>
        <Field label="To"><input type="date" name="to" defaultValue={filters.to ?? ""} className="input" /></Field>
        <div className="pb-0.5 flex gap-2"><button className="btn btn-primary" type="submit">Apply</button>{filtered && <Link href="/finance/audit" className="btn">Clear</Link>}</div>
      </form>

      <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>Every financial action is recorded with who did it, when, and what changed — so each transaction is traceable. Budget-line changes keep their own before/after history on each project&apos;s Budget tab.</p>
      {audit.length === 0 ? (
        <Empty title={filtered ? "No financial activity matches these filters" : "No financial activity recorded yet"} hint={filtered ? "Widen the date range or clear the filters." : "Invoices, receipts, vouchers, requisitions and ledger postings will appear here as they happen."} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">When</th><th className="th text-left">Who</th><th className="th text-left">Action</th><th className="th text-left">Transaction</th><th className="th text-left">Project</th><th className="th text-left">Details</th></tr></thead>
            <tbody>
              {audit.map((e, i) => (
                <tr key={i}>
                  <td className="td whitespace-nowrap">{fmtDateTime(e.createdAt)}</td>
                  <td className="td">{e.actor ?? "—"}</td>
                  <td className="td"><Badge tone={actTone(e.action)}>{label(e.action)}</Badge></td>
                  <td className="td">{label(e.entity)}{e.entityId ? <span className="font-mono text-xs ml-1" style={{ color: "var(--muted)" }}>{e.entityId}</span> : null}</td>
                  <td className="td font-mono text-xs">{e.projectCode ?? "—"}</td>
                  <td className="td" style={{ maxWidth: 300, color: "var(--muted)" }}>{changeSummary(e.before, e.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>Showing up to 300 most recent entries. Narrow with the filters, or export to XLSX for the full filtered set. The audit log is append-only — entries can&apos;t be edited or deleted.</p>
    </div>
  );
}
