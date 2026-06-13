import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { accountBalances } from "@/server/services/ledger";
import { PageHeader, SectionTitle, Field, Badge } from "@/components/ui";
import { money } from "@/lib/format";
import { addLedgerAccountAction, toggleLedgerAccountAction, setPostingRuleAction } from "@/app/actions";

const TYPE_LABEL: Record<string, string> = { asset: "Asset", liability: "Liability", equity: "Equity", income: "Income", expense: "Expense" };
const TYPE_ORDER = ["asset", "liability", "equity", "income", "expense"];

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ added?: string; err?: string; rule?: string; init?: string }> }) {
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;
  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]))?.currency ?? "USD";

  const balances = await accountBalances(orgId);
  const accounts = await q<{ id: string; code: string; name: string; accountType: string; isActive: boolean }>(
    `SELECT id, code, name, account_type AS "accountType", is_active AS "isActive" FROM ledger_account WHERE org_id=$1 ORDER BY code`, [orgId]
  );
  const balByCode = new Map(balances.map((b) => [b.code, b.balance]));
  const rule = await one<{ debit: string | null; credit: string | null }>(
    `SELECT debit_account_id AS debit, credit_account_id AS credit FROM gl_posting_rule WHERE org_id=$1 AND rule_key='expenditure'`, [orgId]
  );

  return (
    <div className="max-w-5xl">
      <PageHeader title="Chart of accounts" subtitle="The master list of ledger accounts" actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.added && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Account added.</div>}
      {sp.init === "ok" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Standard chart of accounts created.</div>}
      {sp.rule === "ok" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Posting rule saved.</div>}
      {sp.err === "dup" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>That account code already exists.</div>}
      {sp.err === "missing" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Code and name are required.</div>}

      {TYPE_ORDER.map((t) => {
        const group = accounts.filter((a) => a.accountType === t);
        if (group.length === 0) return null;
        return (
          <div key={t} className="mb-5">
            <SectionTitle>{TYPE_LABEL[t]} accounts</SectionTitle>
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr><th className="th text-left">Code</th><th className="th text-left">Name</th><th className="th text-right">Balance</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
                <tbody>
                  {group.map((a) => (
                    <tr key={a.id} style={{ opacity: a.isActive ? 1 : 0.5 }}>
                      <td className="td font-mono text-xs">{a.code}</td>
                      <td className="td">{a.name}</td>
                      <td className="td text-right tabular-nums">{money(balByCode.get(a.code) ?? 0, c)}</td>
                      <td className="td">{a.isActive ? <Badge tone="ok">active</Badge> : <Badge tone="muted">inactive</Badge>}</td>
                      <td className="td text-right">
                        <form action={toggleLedgerAccountAction}>
                          <input type="hidden" name="accountId" value={a.id} />
                          <button className="btn btn-sm" type="submit">{a.isActive ? "Deactivate" : "Activate"}</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <div className="grid lg:grid-cols-2 gap-5 mt-6">
        <div>
          <SectionTitle>Add an account</SectionTitle>
          <form action={addLedgerAccountAction} className="card p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code"><input name="code" required className="input" placeholder="5600" /></Field>
              <Field label="Type">
                <select name="accountType" className="select" defaultValue="expense">
                  {TYPE_ORDER.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Name"><input name="name" required className="input" placeholder="e.g. Communications & printing" /></Field>
            <Field label="Description (optional)"><input name="description" className="input" /></Field>
            <button className="btn btn-primary" type="submit">Add account</button>
          </form>
        </div>

        <div>
          <SectionTitle>Expenditure posting rule</SectionTitle>
          <form action={setPostingRuleAction} className="card p-4 space-y-3">
            <p className="text-xs" style={{ color: "var(--muted)" }}>When a project expenditure is recorded, it posts a balanced entry: debit an expense account, credit the source of funds.</p>
            <Field label="Debit (expense account)">
              <select name="debitAccountId" className="select" defaultValue={rule?.debit ?? ""}>
                <option value="">— choose —</option>
                {accounts.filter((a) => a.accountType === "expense").map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </select>
            </Field>
            <Field label="Credit (cash / bank / payable)">
              <select name="creditAccountId" className="select" defaultValue={rule?.credit ?? ""}>
                <option value="">— choose —</option>
                {accounts.filter((a) => a.accountType === "asset" || a.accountType === "liability").map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </select>
            </Field>
            <button className="btn btn-primary" type="submit">Save posting rule</button>
          </form>
        </div>
      </div>
    </div>
  );
}
