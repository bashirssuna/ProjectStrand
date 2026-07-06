import Link from "next/link";
import { requireFinanceOrg } from "./_guard";
import { one } from "@/server/db";
import { institutionalStatements } from "@/server/services/ledger";
import { PageHeader, SectionTitle, Stat, Empty, ToolCard } from "@/components/ui";
import { money } from "@/lib/format";
import { initLedgerAction, reconcileLedgerAction } from "@/app/actions";

export default async function FinanceHome({ searchParams }: { searchParams: Promise<{ reconciled?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;
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
      <PageHeader title="Institution Finance" subtitle={`General ledger & financial statements for ${orgName}`} actions={
        <div className="flex items-center gap-2">
          <form action={reconcileLedgerAction}><button className="btn btn-sm" type="submit" title="Recognise grant income for past spend and overhead for approved budgets">↻ Reconcile ledger</button></form>
          <Link href="/operations" className="btn btn-sm">Institutional overview →</Link>
        </div>
      } />
      {sp.reconciled && (() => { const [o, e] = sp.reconciled.split("-"); return (
        <div className="card p-3 mb-4 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Ledger reconciled — recognised overhead on {o} approved budget{o === "1" ? "" : "s"} and grant income on {e} past expenditure{e === "1" ? "" : "s"}.</div>
      ); })()}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
        <Stat label="Total income" value={money(fs.incomeStatement.totalIncome, c)} sub="all projects" />
        <Stat label="Total expense" value={money(fs.incomeStatement.totalExpense, c)} sub="all projects" />
        <Stat label="Surplus / (deficit)" value={money(fs.incomeStatement.surplus, c)} tone={fs.incomeStatement.surplus < 0 ? "danger" : "ok"} />
        <Stat label="Trial balance" value={fs.trialBalance.balanced ? "Balanced" : "Out!"} tone={fs.trialBalance.balanced ? "ok" : "danger"} sub={`${jeCount} journal entries`} />
      </div>

      <SectionTitle>Ledger tools</SectionTitle>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
        <ToolCard href="/finance/accounts" icon="list" title="Chart of accounts" desc="The master list of accounts and the rule for posting project expenditures." />
        <ToolCard href="/finance/journal" icon="journal" title="General journal" desc="Every posted entry, with manual journals and reversals." />
        <ToolCard href="/finance/statements" icon="statements" title="Financial statements" desc="Trial balance, income statement, balance sheet & cash flow." />
        <ToolCard href="/finance/funding" icon="grant" title="Grant agreements" desc="Donor funding pipeline: committed amounts, expected tranches and income received." />
        <ToolCard href="/finance/revenue" icon="revenue" title="Institutional revenue" desc="Overhead recovered per project & other income, with a contribution pie chart." />
        <ToolCard href="/finance/invoices" icon="invoice" title="Invoices & income" desc="Raise invoices to funders; track receivables; print." />
        <ToolCard href="/finance/receipts" icon="receipt" title="Receipts" desc="Record money received; settle invoices; print receipts." />
        <ToolCard href="/finance/treasury" icon="reserves" title="Reserves & investments" desc="Designated reserve funds and placed investments with maturity tracking." />
        <ToolCard href="/finance/assets" icon="asset" title="Asset register" desc="Fixed assets with straight-line depreciation posting." />
        <ToolCard href="/finance/audits" icon="audit" title="Audit engagements" desc="External, donor & statutory audits with findings and remediation tracking." />
        <ToolCard href="/finance/whistleblower" icon="whistle" title="Whistleblower reports" desc="Confidential reporting channel with anonymous intake and case handling." />
        <ToolCard href="/finance/audit" icon="compliance" title="Audit & compliance" desc="Control checks plus the append-only financial audit trail." />
        <ToolCard href="/finance/vouchers" icon="voucher" title="Payment vouchers" desc="Record payments out; posts to the ledger and feeds reconciliation." />
        <ToolCard href="/finance/payment-slips" icon="slip" title="Payment slips" desc="Bulk or individual payments (airtime, data, transcription) on letterhead — approved & e-signed by each payee." />
        <ToolCard href="/finance/petty-cash" icon="petty" title="Petty cash" desc="Imprest floats with disbursements, replenishment and cash-count reconciliation." />
        <ToolCard href="/finance/cash-forecast" icon="forecast" title="Cash forecast" desc="Rolling cash-position projection with funding, maturities and planned flows." />
        <ToolCard href="/finance/reconcile" icon="reconcile" title="Bank reconciliation" desc="Match the bank statement against the ledger balance." />
        <ToolCard href="/finance/currency" icon="currency" title="Currency & FX rates" desc="Set the base currency and exchange rates for conversion." />
        <ToolCard href="/finance/fx-revaluation" icon="fx" title="FX revaluation" desc="Record foreign entries at the day’s rate and post period-end FX gain/loss." />
        <ToolCard href="/finance/years" icon="calendar" title="Financial years" desc="Define accounting periods and see spend & disbursements per year." />
        <ToolCard href="/subawards" icon="subaward" title="Sub-awards" desc="Pass-through grants to partner organisations and their disbursements." />
      </div>
    </div>
  );
}
