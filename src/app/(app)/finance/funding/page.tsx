import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q } from "@/server/db";
import { listAgreements, agreementStats } from "@/server/services/funding";
import { PageHeader, SectionTitle, Field, Stat, StatusBadge, Badge, Empty, ProgressBar } from "@/components/ui";
import { money, fmtDate, ccyTotal } from "@/lib/format";
import { currencyOptions } from "@/lib/currencies";
import { createAgreementAction } from "@/app/actions";

export default async function FundingPage({ searchParams }: { searchParams: Promise<{ err?: string; status?: string; search?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;
  const [agreements, stats, projects, org] = await Promise.all([
    listAgreements(orgId, { status: sp.status, search: sp.search }),
    agreementStats(orgId),
    q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [orgId]),
    q<{ baseCurrency: string }>(`SELECT base_currency AS "baseCurrency" FROM organization WHERE id=$1`, [orgId]),
  ]);
  const baseCcy = org[0]?.baseCurrency || "USD";
  const committed = ccyTotal(stats.committed, baseCcy), received = ccyTotal(stats.received, baseCcy), outstanding = ccyTotal(stats.outstanding, baseCcy), overdue = ccyTotal(stats.overdueAmount, baseCcy);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Grant agreements" subtitle={`Donor funding, expected tranches & income received for ${orgName}`} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.err === "req" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Donor and title are required.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Committed (active)" value={committed.value} />
        <Stat label="Received" value={received.value} tone={received.parts.some(([, v]) => v > 0) ? "ok" : undefined} />
        <Stat label="Outstanding" value={outstanding.value} tone={outstanding.parts.some(([, v]) => v > 0) ? "warn" : undefined} />
        <Stat label="Overdue tranches" value={stats.overdueCount ? `${stats.overdueCount} · ${overdue.value}` : "0"} tone={stats.overdueCount ? "danger" : undefined} />
      </div>
      <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>Cross-agreement totals assume a common base currency; per-agreement figures use each agreement&apos;s own currency.</p>

      <form className="card p-3 mb-4 flex flex-wrap gap-3 items-end">
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="select select-sm"><option value="">All</option><option value="active">Active</option><option value="closed">Closed</option></select></Field>
        <Field label="Search"><input name="search" defaultValue={sp.search ?? ""} className="input input-sm" placeholder="Donor, title or ref" /></Field>
        <button className="btn btn-sm btn-primary" type="submit">Apply</button>
        <Link href="/finance/funding" className="btn btn-sm">Reset</Link>
      </form>

      <SectionTitle>Agreements</SectionTitle>
      <div className="mt-2 mb-6">
        {agreements.length === 0 ? <Empty title="No agreements" hint="Register a donor funding agreement below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Donor / agreement</th><th className="th text-right">Committed</th><th className="th text-right">Received</th><th className="th text-left">Progress</th><th className="th text-left">Ends</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
              <tbody>
                {agreements.map((a) => {
                  const pct = a.totalAmount > 0 ? Math.min(Math.round((a.received / a.totalAmount) * 100), 100) : 0;
                  return (
                    <tr key={a.id}>
                      <td className="td"><div className="font-medium">{a.donor}</div><div className="text-xs" style={{ color: "var(--muted)" }}>{a.title}{a.reference ? ` · ${a.reference}` : ""}{a.projectTitle ? ` · ${a.projectTitle}` : ""}</div></td>
                      <td className="td text-right whitespace-nowrap">{money(a.totalAmount, a.currency)}</td>
                      <td className="td text-right whitespace-nowrap">{money(a.received, a.currency)}</td>
                      <td className="td" style={{ minWidth: 120 }}><div className="flex items-center gap-2"><ProgressBar value={pct} /><span className="text-xs" style={{ color: "var(--muted)" }}>{pct}%</span></div></td>
                      <td className="td whitespace-nowrap">{a.endDate ? fmtDate(a.endDate) : "—"}</td>
                      <td className="td"><StatusBadge status={a.status} /></td>
                      <td className="td text-right"><Link href={`/finance/funding/${a.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card p-4">
        <SectionTitle>Register an agreement</SectionTitle>
        <form action={createAgreementAction} className="grid sm:grid-cols-2 gap-3 mt-2">
          <Field label="Donor / funder *"><input name="donor" required className="input" placeholder="e.g. Wellcome Trust" /></Field>
          <Field label="Agreement title *"><input name="title" required className="input" placeholder="e.g. TB Diabetes Cohort Grant" /></Field>
          <Field label="Reference no."><input name="reference" className="input" /></Field>
          <Field label="Project (optional)"><select name="projectId" className="select"><option value="">—</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.title}</option>)}</select></Field>
          <Field label="Currency"><select name="currency" defaultValue={baseCcy} className="select">{currencyOptions(baseCcy).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="Total committed"><input name="totalAmount" type="number" step="0.01" min="0" className="input" placeholder="0.00" /></Field>
          <Field label="Signed date"><input name="signedDate" type="date" className="input" /></Field>
          <Field label="Focal person"><input name="focalPerson" className="input" /></Field>
          <Field label="Start date"><input name="startDate" type="date" className="input" /></Field>
          <Field label="End date"><input name="endDate" type="date" className="input" /></Field>
          <Field label="Signed agreement (PDF)"><input name="file" type="file" className="input" /></Field>
          <div className="sm:col-span-2"><Field label="Notes"><input name="notes" className="input" /></Field></div>
          <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Register agreement</button></div>
        </form>
      </div>
    </div>
  );
}
