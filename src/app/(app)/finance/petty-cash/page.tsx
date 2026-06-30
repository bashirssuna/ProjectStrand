import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q } from "@/server/db";
import { listAccounts, accountStats } from "@/server/services/pettycash";
import { PageHeader, SectionTitle, Field, Stat, Badge, Empty, ProgressBar } from "@/components/ui";
import { money, ccyTotal } from "@/lib/format";
import { currencyOptions } from "@/lib/currencies";
import { createPettyCashAccountAction } from "@/app/actions";

export default async function PettyCashPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName, } = await requireFinanceOrg();
  const sp = await searchParams;
  const [accounts, stats, employees, org, projects] = await Promise.all([
    listAccounts(orgId),
    accountStats(orgId),
    q<{ id: string; name: string }>(`SELECT id, (first_name || ' ' || last_name) AS name FROM employee WHERE org_id=$1 AND status != 'terminated' ORDER BY first_name, last_name`, [orgId]),
    q<{ baseCurrency: string }>(`SELECT base_currency AS "baseCurrency" FROM organization WHERE id=$1`, [orgId]),
    q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [orgId]),
  ]);
  const baseCcy = org[0]?.baseCurrency || "UGX";
  const onHand = ccyTotal(stats.onHand, baseCcy), limit = ccyTotal(stats.limit, baseCcy), replenish = ccyTotal(stats.replenishDue, baseCcy);
  const replenishPositive = replenish.parts.some(([, v]) => v > 0);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Petty cash" subtitle={`Imprest floats, disbursements & replenishment for ${orgName}`} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.err === "name" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A float name is required.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Active floats" value={String(stats.active)} />
        <Stat label="Cash on hand" value={onHand.value} sub={limit.empty ? undefined : `of ${limit.value} limit`} />
        <Stat label="Replenishment due" value={replenish.empty ? money(0, baseCcy) : replenish.value} tone={replenishPositive ? "warn" : undefined} />
        <Stat label="Low floats" value={String(stats.lowCount)} tone={stats.lowCount ? "danger" : undefined} />
      </div>
      <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>Cross-float totals assume a common base currency; per-float figures use each float&apos;s own currency.</p>

      <SectionTitle>Floats</SectionTitle>
      <div className="mt-2 mb-6">
        {accounts.length === 0 ? <Empty title="No petty cash floats" hint="Create an imprest float below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Float</th><th className="th text-left">Custodian</th><th className="th text-right">Limit</th><th className="th text-right">On hand</th><th className="th text-left">Utilisation</th><th className="th text-right">Replenish</th><th className="th" /></tr></thead>
              <tbody>
                {accounts.map((a) => {
                  const used = a.floatLimit > 0 ? Math.min(Math.round(((a.floatLimit - a.balance) / a.floatLimit) * 100), 100) : 0;
                  return (
                    <tr key={a.id}>
                      <td className="td"><div className="font-medium">{a.name}{a.status === "closed" && <span className="ml-2"><Badge tone="muted">Closed</Badge></span>}{a.low && <span className="ml-2"><Badge tone="danger">Low</Badge></span>}</div></td>
                      <td className="td">{a.custodian ?? "—"}{a.projectTitle && <div className="text-xs" style={{ color: "var(--muted)" }}>{a.projectTitle}</div>}</td>
                      <td className="td text-right whitespace-nowrap">{money(a.floatLimit, a.currency)}</td>
                      <td className="td text-right whitespace-nowrap">{money(a.balance, a.currency)}</td>
                      <td className="td" style={{ minWidth: 120 }}><ProgressBar value={used} /></td>
                      <td className="td text-right whitespace-nowrap">{a.replenishDue > 0 ? money(a.replenishDue, a.currency) : "—"}</td>
                      <td className="td text-right"><Link href={`/finance/petty-cash/${a.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card p-4">
        <SectionTitle>New petty cash float</SectionTitle>
        <form action={createPettyCashAccountAction} className="grid sm:grid-cols-2 gap-3 mt-2">
          <Field label="Float name *"><input name="name" required className="input" placeholder="e.g. Head Office Petty Cash" /></Field>
          <Field label="Custodian"><input name="custodian" className="input" placeholder="Name of cash holder" /></Field>
          <Field label="Link to employee (optional)"><select name="custodianEmployeeId" className="select"><option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
          <Field label="Link to project (optional)"><select name="projectId" className="select"><option value="">—</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.title}</option>)}</select></Field>
          <Field label="Currency"><select name="currency" defaultValue={baseCcy} className="select">{currencyOptions(baseCcy).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="Float limit (imprest ceiling)"><input name="floatLimit" type="number" step="0.01" min="0" className="input" placeholder="0.00" /></Field>
          <Field label="Opening float (optional)"><input name="opening" type="number" step="0.01" min="0" className="input" placeholder="0.00" /></Field>
          <div className="sm:col-span-2"><Field label="Notes"><input name="notes" className="input" /></Field></div>
          <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Create float</button></div>
        </form>
      </div>
    </div>
  );
}
