import Link from "next/link";
import { requireProcOrg } from "../_guard";
import { q } from "@/server/db";
import { getProcurementConfig, requiredQuotations } from "@/server/services/procurement";
import { PageHeader, SectionTitle, Field, StatusBadge, Empty, Badge } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { createPurchaseRequestAction, createPOAction } from "@/app/actions";
import { ExportMenu } from "@/components/export-menu";

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ created?: string; decided?: string; err?: string }> }) {
  const { orgId } = await requireProcOrg();
  const sp = await searchParams;
  const procCfg = await getProcurementConfig(orgId);
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY created_at DESC`, [orgId]);
  const vendors = await q<{ id: string; name: string }>(`SELECT id, name FROM vendor WHERE org_id=$1 AND active ORDER BY name`, [orgId]);
  const quoteCounts = new Map((await q<{ requestId: string; c: number }>(
    `SELECT request_id AS "requestId", COUNT(*)::int c FROM pr_quotation GROUP BY request_id`, []
  )).map((r) => [r.requestId, r.c]));
  // Budget lines across the org's projects, for charging a request to a line.
  const budgetLines = await q<{ id: string; code: string; description: string; projectId: string; projectCode: string }>(
    `SELECT bl.id, bl.code, bl.description, b.project_id AS "projectId", p.code AS "projectCode"
     FROM budget_line bl JOIN budget b ON b.id=bl.budget_id JOIN project p ON p.id=b.project_id
     WHERE p.org_id=$1 ORDER BY p.code, bl.code`, [orgId]
  );
  const linesByProject = new Map<string, { id: string; code: string; description: string; projectCode: string }[]>();
  for (const l of budgetLines) {
    if (!linesByProject.has(l.projectCode)) linesByProject.set(l.projectCode, []);
    linesByProject.get(l.projectCode)!.push(l);
  }
  const requests = await q<{ id: string; number: string; title: string; estimatedTotal: number; currency: string; status: string; neededBy: string | null; requestedByName: string | null; projectCode: string | null; projectId: string | null; lineCode: string | null; lineDesc: string | null }>(
    `SELECT pr.id, pr.number, pr.title, pr.estimated_total::float AS "estimatedTotal", pr.currency, pr.status,
            pr.needed_by AS "neededBy", pr.requested_by_name AS "requestedByName",
            p.code AS "projectCode", p.id AS "projectId", bl.code AS "lineCode", bl.description AS "lineDesc"
     FROM purchase_request pr
     LEFT JOIN project p ON p.id=pr.project_id
     LEFT JOIN budget_line bl ON bl.id=pr.budget_line_id
     WHERE pr.org_id=$1 ORDER BY pr.created_at DESC LIMIT 50`, [orgId]
  );

  return (
    <div className="max-w-5xl">
      <PageHeader title="Purchase requests" subtitle="Raise, approve, and convert to orders" actions={<div className="flex flex-wrap gap-2 no-print"><Link href="/print/procurement/requests" target="_blank" className="btn btn-sm">Print</Link><ExportMenu scope="requests" /><Link href="/procurement/config" className="btn btn-sm">Thresholds</Link><Link href="/procurement" className="btn btn-sm">← Procurement</Link></div>} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Purchase request submitted.</div>}
      {sp.decided && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Decision recorded.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{sp.err === "vendor" ? "Choose a vendor to create the order." : sp.err === "1" ? "Title and item description are required." : decodeURIComponent(sp.err)}</div>}

      <SectionTitle>Requests</SectionTitle>
      {requests.length === 0 ? <Empty title="No purchase requests yet" hint="Raise one below; once approved you can turn it into a purchase order." /> : (
        <div className="space-y-3 mb-6">
          {requests.map((r) => (
            <div key={r.id} className="card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs" style={{ color: "var(--brand)" }}>{r.number}</span>
                  <span className="font-medium">{r.title}</span>
                  <StatusBadge status={r.status} />
                </div>
                <span className="tabular-nums font-medium">{money(r.estimatedTotal, r.currency)}</span>
              </div>
              <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>By {r.requestedByName ?? "—"}{r.neededBy ? ` · needed by ${fmtDate(r.neededBy)}` : ""}</div>
              {r.projectCode && (
                <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>
                  Charged to <Link href={`/projects/${r.projectId}/budget`} className="hover:underline" style={{ color: "var(--brand)" }}>{r.projectCode}</Link>
                  {r.lineCode ? ` · line ${r.lineCode} — ${r.lineDesc}` : " · no budget line"}
                  {r.status === "approved" && r.lineCode ? " · committed to budget" : ""}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
                {(() => { const req = requiredQuotations(procCfg, r.estimatedTotal); const have = quoteCounts.get(r.id) ?? 0; return (
                  <Badge tone={have >= req.required ? "ok" : "warn"}>{req.label}: {have}/{req.required} quotes</Badge>
                ); })()}
                <Link href={`/procurement/requests/${r.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open / quotations →</Link>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {r.status === "submitted" && (
                  <Link href={`/procurement/requests/${r.id}`} className="btn btn-sm btn-primary">Review &amp; sign →</Link>
                )}
                {r.status === "approved" && vendors.length > 0 && (
                  <form action={createPOAction} className="flex items-end gap-2">
                    <input type="hidden" name="requestId" value={r.id} />
                    <select name="vendorId" required className="select" style={{ width: 180 }}><option value="">— choose vendor —</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
                    <button className="btn btn-sm btn-primary" type="submit">Create purchase order</button>
                  </form>
                )}
                {r.status === "approved" && vendors.length === 0 && <span className="text-xs" style={{ color: "var(--danger)" }}>Add a vendor first to create an order.</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      <SectionTitle>Raise a purchase request</SectionTitle>
      <form action={createPurchaseRequestAction} className="card p-4 grid sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2"><Field label="Title"><input name="title" required className="input" placeholder="e.g. Field laptops for data team" /></Field></div>
        <Field label="Project (optional)"><select name="projectId" className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select></Field>
        <div className="sm:col-span-3">
          <Field label="Budget line to charge (optional)">
            <select name="budgetLineId" className="select">
              <option value="">— none (not charged to a project budget) —</option>
              {[...linesByProject.entries()].map(([projectCode, lines]) => (
                <optgroup key={projectCode} label={projectCode}>
                  {lines.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.description}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
            {budgetLines.length === 0
              ? "No budget lines yet — add a budget to a project first to charge requests against it."
              : "Pick a line to charge this request to a project budget. Its project is used automatically, and on approval the estimated cost is committed against that line."}
          </p>
        </div>
        <div className="sm:col-span-3"><Field label="Item description"><input name="itemDescription" required className="input" placeholder="e.g. Dell Latitude 5440" /></Field></div>
        <Field label="Quantity"><input type="number" step="0.01" name="quantity" defaultValue={1} className="input" /></Field>
        <Field label="Unit"><input name="unit" className="input" placeholder="pcs" /></Field>
        <Field label="Est. unit cost"><input type="number" step="0.01" name="unitCost" className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue="USD" className="input" /></Field>
        <Field label="Needed by"><input type="date" name="neededBy" className="input" /></Field>
        <div className="sm:col-span-3"><Field label="Justification"><textarea name="justification" rows={2} className="textarea" /></Field></div>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Submit request</button></div>
      </form>
    </div>
  );
}
