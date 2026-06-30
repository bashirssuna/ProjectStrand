import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty, Stat } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { addPerdiemRateAction, deletePerdiemRateAction, createPerdiemClaimAction } from "@/app/actions";

export default async function PerdiemPage({ searchParams }: { searchParams: Promise<{ saved?: string; err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;

  const rates = await q<{ id: string; category: string; dailyRate: number; currency: string; note: string | null }>(
    `SELECT id, category, daily_rate::float AS "dailyRate", currency, note FROM perdiem_rate WHERE org_id=$1 ORDER BY category`, [orgId]
  );
  const claims = await q<{ id: string; travellerName: string; purpose: string | null; destination: string | null; days: number; total: number; currency: string; status: string; startDate: string | null; hasReport: boolean }>(
    `SELECT id, traveller_name AS "travellerName", purpose, destination, days::float, total::float, currency, status,
            start_date AS "startDate", (activity_report IS NOT NULL AND activity_report <> '') AS "hasReport"
     FROM perdiem_claim WHERE org_id=$1 ORDER BY created_at DESC LIMIT 60`, [orgId]
  );
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY created_at DESC`, [orgId]);
  const baseCcy = (await q<{ c: string }>(`SELECT COALESCE(base_currency,'USD') c FROM organization WHERE id=$1`, [orgId]))[0]?.c ?? "USD";
  const employees = await q<{ id: string; name: string }>(`SELECT id, (first_name || ' ' || last_name) AS name FROM employee WHERE org_id=$1 ORDER BY last_name`, [orgId]);
  const pending = claims.filter((c) => c.status === "draft" || c.status === "approved").length;

  return (
    <div className="max-w-5xl">
      <PageHeader title="Per diem & travel" subtitle={`Travel allowances with mandatory activity reports · ${orgName}`} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.err === "claimfields" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A traveller name is required.</div>}
      {sp.err === "ratefields" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A category is required for a rate.</div>}

      <div className="grid grid-cols-2 gap-3 mb-6">
        <Stat label="Claims pending" value={String(pending)} tone={pending ? "warn" : undefined} />
        <Stat label="Rate categories" value={String(rates.length)} />
      </div>
      <p className="text-sm mb-5" style={{ color: "var(--muted)" }}>
        Per-diem payments must be supported by an activity report describing the work done on the trip — a claim cannot be approved without one.
        Use rates that are the lower of the funder&apos;s and the institution&apos;s schedules.
      </p>

      <SectionTitle>Claims</SectionTitle>
      {claims.length === 0 ? <Empty title="No per-diem claims yet" hint="Raise one below; add the activity report, then approve and pay." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">Traveller</th><th className="th text-left">Purpose</th>
              <th className="th text-right">Days</th><th className="th text-right">Total</th>
              <th className="th text-left">Report</th><th className="th text-left">Status</th><th className="th" />
            </tr></thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.id}>
                  <td className="td font-medium">{c.travellerName}</td>
                  <td className="td text-xs">{c.purpose ?? c.destination ?? "—"}</td>
                  <td className="td text-right">{c.days}</td>
                  <td className="td text-right tabular-nums">{money(c.total, c.currency)}</td>
                  <td className="td">{c.hasReport ? <Badge tone="ok">yes</Badge> : <Badge tone="warn">missing</Badge>}</td>
                  <td className="td">{c.status === "paid" ? <Badge tone="ok">paid</Badge> : c.status === "approved" ? <Badge tone="info">approved</Badge> : c.status === "rejected" ? <Badge tone="danger">rejected</Badge> : <Badge tone="muted">draft</Badge>}</td>
                  <td className="td text-right"><Link href={`/finance/perdiem/${c.id}`} className="btn btn-sm">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Raise a per-diem claim</SectionTitle>
      <form action={createPerdiemClaimAction} className="card p-4 grid sm:grid-cols-4 gap-3 mb-6">
        <div className="sm:col-span-2"><Field label="Traveller"><input name="travellerName" list="emp-names" required className="input" />
          <datalist id="emp-names">{employees.map((e) => <option key={e.id} value={e.name} />)}</datalist>
        </Field></div>
        <Field label="Project (optional)"><select name="projectId" className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select></Field>
        <Field label="Currency"><input name="currency" defaultValue={rates[0]?.currency ?? baseCcy} className="input" /></Field>
        <div className="sm:col-span-2"><Field label="Purpose"><input name="purpose" className="input" placeholder="e.g. Field data collection in Mayuge" /></Field></div>
        <Field label="Destination"><input name="destination" className="input" /></Field>
        <div />
        <Field label="Start date"><input type="date" name="startDate" className="input" /></Field>
        <Field label="End date"><input type="date" name="endDate" className="input" /></Field>
        <Field label="Days"><input type="number" step="0.5" name="days" className="input" /></Field>
        <Field label="Daily rate"><input type="number" step="0.01" name="dailyRate" list="rate-values" className="input" />
          <datalist id="rate-values">{rates.map((r) => <option key={r.id} value={r.dailyRate}>{r.category}</option>)}</datalist>
        </Field>
        <div className="sm:col-span-4"><Field label="Activity report (can be added later, required before approval)"><textarea name="activityReport" rows={2} className="textarea" /></Field></div>
        <div className="sm:col-span-4 flex justify-end"><button className="btn btn-primary" type="submit">Create claim</button></div>
      </form>

      <SectionTitle>Per-diem rate schedule</SectionTitle>
      {rates.length > 0 && (
        <div className="card overflow-x-auto mb-3">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Category</th><th className="th text-right">Daily rate</th><th className="th text-left">Note</th><th className="th" /></tr></thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id}>
                  <td className="td">{r.category}</td>
                  <td className="td text-right tabular-nums">{money(r.dailyRate, r.currency)}</td>
                  <td className="td text-xs">{r.note ?? "—"}</td>
                  <td className="td text-right"><form action={deletePerdiemRateAction}><input type="hidden" name="rateId" value={r.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button></form></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form action={addPerdiemRateAction} className="card p-4 grid sm:grid-cols-4 gap-3 items-end">
        <Field label="Category"><input name="category" required className="input" placeholder="e.g. Senior staff" /></Field>
        <Field label="Daily rate"><input type="number" step="0.01" name="dailyRate" className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue={baseCcy} className="input" /></Field>
        <div className="flex justify-end"><button className="btn btn-primary" type="submit">Add rate</button></div>
      </form>
    </div>
  );
}
