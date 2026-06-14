import Link from "next/link";
import { requireFinanceOrg } from "./_guard";
import { one } from "@/server/db";
import { institutionalStatements } from "@/server/services/ledger";
import { PageHeader, SectionTitle, Stat, Empty } from "@/components/ui";
import { money } from "@/lib/format";
import { initLedgerAction } from "@/app/actions";

export default async function FinanceHome() {
  const { orgId, orgName } = await requireFinanceOrg();
  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]))?.currency ?? "USD";
  const accCount = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ledger_account WHERE org_id=$1`, [orgId]))?.c ?? 0;

  if (accCount === 0) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Institution Finance" subtitle={`General ledger & financial statements for ${orgName}`} />
        <Empty title="Set up your chart of accounts"
          hint="The general ledger is the institutional backbone — every expenditure and payment posts a balanced double-entry here, and your financial statements roll up across all projects. Start with a standard non-profit chart of accounts, then customise it." />
        <form action={initLedgerAction} className="mt-4">
          <button className="btn btn-primary" type="submit">Initialise chart of accounts</button>
        </form>
        <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
          This creates ~20 standard accounts (cash, receivables, grant income, expense categories, fund balances). You can add, rename or deactivate any of them afterwards.
        </p>
      </div>
    );
  }

  const fs = await institutionalStatements(orgId);
  const jeCount = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM journal_entry WHERE org_id=$1`, [orgId]))?.c ?? 0;

  return (
    <div>
      <PageHeader title="Institution Finance" subtitle={`General ledger & financial statements for ${orgName}`} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
        <Stat label="Total income" value={money(fs.incomeStatement.totalIncome, c)} sub="all projects" />
        <Stat label="Total expense" value={money(fs.incomeStatement.totalExpense, c)} sub="all projects" />
        <Stat label="Surplus / (deficit)" value={money(fs.incomeStatement.surplus, c)} tone={fs.incomeStatement.surplus < 0 ? "danger" : "ok"} />
        <Stat label="Trial balance" value={fs.trialBalance.balanced ? "Balanced" : "Out!"} tone={fs.trialBalance.balanced ? "ok" : "danger"} sub={`${jeCount} journal entries`} />
      </div>

      <SectionTitle>Ledger tools</SectionTitle>
      <div className="grid sm:grid-cols-3 gap-4">
        <Link href="/finance/accounts" className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
          <div className="font-display font-semibold">Chart of accounts</div>
          <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>The master list of accounts and the rule for posting project expenditures.</div>
        </Link>
        <Link href="/finance/journal" className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
          <div className="font-display font-semibold">General journal</div>
          <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>Every posted entry, with manual journals and reversals.</div>
        </Link>
        <Link href="/finance/statements" className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
          <div className="font-display font-semibold">Financial statements</div>
          <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>Trial balance, income statement, balance sheet &amp; cash flow.</div>
        </Link>
        <Link href="/finance/invoices" className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
          <div className="font-display font-semibold">Invoices &amp; income</div>
          <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>Raise invoices to funders; track receivables; print.</div>
        </Link>
        <Link href="/finance/receipts" className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
          <div className="font-display font-semibold">Receipts</div>
          <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>Record money received; settle invoices; print receipts.</div>
        </Link>
        <Link href="/finance/assets" className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
          <div className="font-display font-semibold">Asset register</div>
          <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>Fixed assets with straight-line depreciation posting.</div>
        </Link>
        <Link href="/finance/reconcile" className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
          <div className="font-display font-semibold">Bank reconciliation</div>
          <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>Match the bank statement against the ledger balance.</div>
        </Link>
        <Link href="/finance/currency" className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
          <div className="font-display font-semibold">Currency &amp; FX rates</div>
          <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>Set the base currency and exchange rates for conversion.</div>
        </Link>
        <Link href="/finance/years" className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
          <div className="font-display font-semibold">Financial years</div>
          <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>Define accounting periods and see spend &amp; disbursements per year.</div>
        </Link>
        <Link href="/subawards" className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
          <div className="font-display font-semibold">Sub-awards</div>
          <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>Pass-through grants to partner organisations and their disbursements.</div>
        </Link>
        <Link href="/finance/remittances" className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
          <div className="font-display font-semibold">Statutory remittances</div>
          <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>PAYE, NSSF &amp; LST filing register with deadlines and receipts.</div>
        </Link>
      </div>
    </div>
  );
}
