import Link from "next/link";
import { requireSubawardOrg } from "./_guard";
import { q } from "@/server/db";
import { listSubawards, subawardRollups } from "@/server/services/subawards";
import { PageHeader, SectionTitle, Field, Badge, Empty, Stat, StatusBadge } from "@/components/ui";
import { money, fmtDate, pct } from "@/lib/format";
import { createSubawardAction } from "@/app/actions";

export default async function SubawardsPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireSubawardOrg();
  const sp = await searchParams;
  const awards = await listSubawards(orgId);
  const rollups = await subawardRollups(orgId);
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY created_at DESC`, [orgId]);
  const partners = await q<{ id: string; name: string }>(`SELECT id, name FROM collaborator WHERE org_id=$1 ORDER BY name`, [orgId]);

  return (
    <div className="max-w-6xl">
      <PageHeader title="Sub-awards" subtitle={`Pass-through grants to partner organisations · ${orgName}`} />
      {sp.err === "fields" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Grantee name and title are required.</div>}

      <p className="text-sm mb-5" style={{ color: "var(--muted)" }}>
        A sub-award is funding passed from one of your projects to an external organisation (a sub-grantee) to run part of the work.
        Track the agreement, the committed amount, the period and every disbursement here.
      </p>

      {rollups.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
          {rollups.map((r) => (
            <Stat key={r.currency} label={`Committed (${r.currency})`} value={money(r.committed, r.currency)} sub={`${r.disbursed ? money(r.disbursed, r.currency) + " disbursed · " : ""}${r.count} award${r.count === 1 ? "" : "s"}`} />
          ))}
        </div>
      )}

      <SectionTitle>All sub-awards</SectionTitle>
      {awards.length === 0 ? <Empty title="No sub-awards yet" hint="Record your first pass-through grant below." /> : (
        <div className="card overflow-x-auto mb-7">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">Grantee</th><th className="th text-left">From project</th>
              <th className="th text-right">Amount</th><th className="th text-right">Disbursed</th>
              <th className="th text-left">Period</th><th className="th text-left">Status</th><th className="th" />
            </tr></thead>
            <tbody>
              {awards.map((a) => (
                <tr key={a.id}>
                  <td className="td"><div className="font-medium">{a.granteeName}</div><div className="text-xs" style={{ color: "var(--muted)" }}>{a.title}</div></td>
                  <td className="td text-xs">{a.projectCode ? <span style={{ color: "var(--brand)" }}>{a.projectCode}</span> : "—"}</td>
                  <td className="td text-right tabular-nums">{money(a.amount, a.currency)}</td>
                  <td className="td text-right tabular-nums">{money(a.disbursed, a.currency)}<span className="text-xs block" style={{ color: "var(--muted)" }}>{a.amount > 0 ? pct(a.disbursed / a.amount) : "—"}</span></td>
                  <td className="td text-xs">{a.startDate ? fmtDate(a.startDate) : "—"}{a.endDate ? ` – ${fmtDate(a.endDate)}` : ""}</td>
                  <td className="td"><StatusBadge status={a.status} /></td>
                  <td className="td text-right"><Link href={`/subawards/${a.id}`} className="btn btn-sm">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>New sub-award</SectionTitle>
      <form action={createSubawardAction} className="card p-4 grid sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2"><Field label="Grantee organisation"><input name="granteeName" required className="input" placeholder="e.g. District Health Office" /></Field></div>
        <Field label="Link to partner (optional)"><select name="collaboratorId" className="select"><option value="">— none —</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <div className="sm:col-span-3"><Field label="Title / scope"><input name="title" required className="input" placeholder="Community mobilisation in Mayuge sub-counties" /></Field></div>
        <Field label="Funded from project"><select name="projectId" className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.title}</option>)}</select></Field>
        <Field label="Agreement reference"><input name="reference" className="input" placeholder="SUB-2025-001" /></Field>
        <Field label="Status"><select name="status" className="select"><option value="draft">Draft</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="completed">Completed</option><option value="closed">Closed</option></select></Field>
        <Field label="Amount"><input type="number" step="0.01" name="amount" className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue="USD" className="input" /></Field>
        <div />
        <Field label="Start date"><input type="date" name="startDate" className="input" /></Field>
        <Field label="End date"><input type="date" name="endDate" className="input" /></Field>
        <div />
        <Field label="Contact person"><input name="contactName" className="input" /></Field>
        <Field label="Contact email"><input name="contactEmail" className="input" /></Field>
        <div />
        <div className="sm:col-span-3"><Field label="Activities the grantee will run"><textarea name="description" rows={2} className="textarea" /></Field></div>
        <div className="sm:col-span-3"><Field label="Deliverables / milestones"><textarea name="deliverables" rows={2} className="textarea" /></Field></div>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Create sub-award</button></div>
      </form>
    </div>
  );
}
