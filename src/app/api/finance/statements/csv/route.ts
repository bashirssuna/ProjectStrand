import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { institutionalStatements } from "@/server/services/ledger";

export async function GET() {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) return new Response("Forbidden", { status: 403 });
  const fs = await institutionalStatements(org.id);
  const esc = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows: (string | number)[][] = [];
  rows.push([`${fs.orgName} — Financial Statements as at ${fs.asOf}`]);
  rows.push([]); rows.push(["TRIAL BALANCE"]); rows.push(["Code", "Account", "Debit", "Credit"]);
  for (const a of fs.trialBalance.accounts) rows.push([a.code, a.name, a.debit, a.credit]);
  rows.push(["", "Totals", fs.trialBalance.totalDebit, fs.trialBalance.totalCredit]);
  rows.push([]); rows.push(["INCOME STATEMENT"]); rows.push(["Code", "Account", "Amount"]);
  for (const a of fs.incomeStatement.income) rows.push([a.code, a.name, a.balance]);
  rows.push(["", "Total income", fs.incomeStatement.totalIncome]);
  for (const a of fs.incomeStatement.expenses) rows.push([a.code, a.name, a.balance]);
  rows.push(["", "Total expenditure", fs.incomeStatement.totalExpense]);
  rows.push(["", "Surplus/(Deficit)", fs.incomeStatement.surplus]);
  rows.push([]); rows.push(["BALANCE SHEET"]); rows.push(["Code", "Account", "Amount"]);
  for (const a of fs.balanceSheet.assets) rows.push([a.code, a.name, a.balance]);
  rows.push(["", "Total assets", fs.balanceSheet.totalAssets]);
  for (const a of fs.balanceSheet.liabilities) rows.push([a.code, a.name, a.balance]);
  rows.push(["", "Total liabilities", fs.balanceSheet.totalLiabilities]);
  for (const a of fs.balanceSheet.equity) rows.push([a.code, a.name, a.balance]);
  rows.push(["", "Current surplus", fs.balanceSheet.surplus]);
  const csv = rows.map((r) => r.map(esc).join(",")).join("\n");
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="institutional-statements.csv"` } });
}
