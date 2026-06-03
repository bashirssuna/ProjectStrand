import Link from "next/link";
import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import { budgetLineRollups } from "@/server/services/budget";
import { createRequisitionAction } from "@/app/actions";
import { SectionTitle, Empty, StatusBadge, Field } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";

export default async function RequisitionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getProjectAccess(id);
  const canCreate = access.permissions.has("requisitions.create");
  const proj = await one<{ currency: string }>(`SELECT currency FROM project WHERE id=$1`, [id]);
  const c = proj?.currency ?? "USD";

  const reqs = await q<{ id: string; number: string; title: string; amount: number; status: string; neededBy: string | null; requester: string | null }>(
    `SELECT r.id, r.number, r.title, r.amount, r.status, r.needed_by AS "neededBy", u.name AS requester
     FROM requisition r LEFT JOIN app_user u ON u.id = r.requested_by_id
     WHERE r.project_id=$1 ORDER BY r.created_at DESC`, [id]
  );

  const bud = await one<{ id: string }>(`SELECT id FROM budget WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [id]);
  const lines = bud ? await budgetLineRollups(bud.id) : [];
  const activities = await q<{ id: string; title: string; code: string | null }>(
    `SELECT id, title, code FROM activity WHERE project_id=$1 AND type<>'milestone' ORDER BY "order"`, [id]
  );

  return (
    <div className="space-y-7">
      <div>
        <SectionTitle>Requisitions</SectionTitle>
        {reqs.length === 0 ? (
          <Empty title="No requisitions" hint={canCreate ? "Raise a requisition below to request funds for an activity." : "No requisitions raised yet."} />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left">Number</th>
                <th className="th text-left">Title</th>
                <th className="th text-left">Requested by</th>
                <th className="th text-left">Needed by</th>
                <th className="th text-left">Status</th>
                <th className="th text-right">Amount</th>
              </tr></thead>
              <tbody>
                {reqs.map((r) => (
                  <tr key={r.id} className="hover:bg-[var(--surface)]">
                    <td className="td"><Link href={`/projects/${id}/requisitions/${r.id}`} className="font-mono text-xs hover:underline" style={{ color: "var(--brand)" }}>{r.number}</Link></td>
                    <td className="td">{r.title}</td>
                    <td className="td">{r.requester ?? "—"}</td>
                    <td className="td whitespace-nowrap">{fmtDate(r.neededBy)}</td>
                    <td className="td"><StatusBadge status={r.status} /></td>
                    <td className="td text-right tabular-nums font-medium">{money(r.amount, c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canCreate && (
        <div>
          <SectionTitle>Raise a requisition</SectionTitle>
          <form action={createRequisitionAction} className="card p-4 grid sm:grid-cols-2 gap-4">
            <input type="hidden" name="projectId" value={id} />
            <Field label="Title"><input name="title" required className="input" placeholder="Funds for training workshop" /></Field>
            <Field label="Amount"><input type="number" step="0.01" name="amount" required className="input" /></Field>
            <Field label="Budget line">
              <select name="budgetLineId" className="select">
                <option value="">— none —</option>
                {lines.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.description} ({money(l.remaining, c)} left)</option>)}
              </select>
            </Field>
            <Field label="Activity">
              <select name="activityId" className="select">
                <option value="">— none / enter manually below —</option>
                {activities.map((a) => <option key={a.id} value={a.id}>{a.code ? a.code + " " : ""}{a.title}</option>)}
              </select>
            </Field>
            <Field label="…or type a new activity">
              <input name="newActivity" className="input" placeholder="e.g. Community sensitisation meeting" />
            </Field>
            <Field label="Needed by"><input type="date" name="neededBy" className="input" /></Field>
            <Field label="Payee"><input name="payee" className="input" /></Field>
            <div className="sm:col-span-2"><Field label="Justification"><textarea name="justification" rows={2} className="textarea" /></Field></div>
            <div className="sm:col-span-2 flex justify-end">
              <button className="btn btn-primary" type="submit">Create draft</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
