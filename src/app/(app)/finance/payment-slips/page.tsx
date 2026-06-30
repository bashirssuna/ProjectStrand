import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q } from "@/server/db";
import { listSlips } from "@/server/services/payment-slips";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { createPaymentSlipAction } from "@/app/actions";

const CATEGORIES = ["Airtime", "Data", "Transcription", "Transport / Fuel", "Allowance / Per diem", "Stipend", "Other"];

function statusTone(s: string) {
  return s === "closed" ? "ok" : s === "disbursed" ? "ok" : s === "approved" ? "info" : "muted";
}

export default async function PaymentSlipsPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;
  const slips = await listSlips(orgId);
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [orgId]);
  const baseCcy = (await q<{ c: string }>(`SELECT COALESCE(base_currency,'USD') c FROM organization WHERE id=$1`, [orgId]))[0]?.c ?? "USD";

  return (
    <div className="max-w-5xl">
      <PageHeader title="Payment slips" subtitle="Bulk or individual payments (airtime, data, transcription…) on letterhead, approved and e-signed"
        actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />

      {sp.err === "title" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Give the payment slip a title.</div>}

      <SectionTitle>Payment slips</SectionTitle>
      {slips.length === 0 ? (
        <Empty title="No payment slips yet" hint="Create one below — add the people to be paid, get Finance and the PI to sign, then email each person a link to sign for their payment." />
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">No.</th><th className="th text-left">Title</th><th className="th text-left">Category</th>
              <th className="th text-left">Date</th><th className="th text-right">Payees</th><th className="th text-right">Total</th>
              <th className="th text-left">Approval</th><th className="th text-left">Signed</th><th className="th text-left">Status</th><th className="th"></th>
            </tr></thead>
            <tbody>
              {slips.map((s) => (
                <tr key={s.id}>
                  <td className="td font-mono text-xs">{s.number}</td>
                  <td className="td">{s.title}{s.project && <span className="text-xs" style={{ color: "var(--muted)" }}> · {s.project}</span>}</td>
                  <td className="td">{s.category ?? "—"}</td>
                  <td className="td whitespace-nowrap">{fmtDate(s.slipDate)}</td>
                  <td className="td text-right">{s.payees}</td>
                  <td className="td text-right whitespace-nowrap">{money(s.total, s.currency)}</td>
                  <td className="td text-xs">{s.financeSignedAt ? "Fin ✓" : "Fin —"} · {s.piSignedAt ? "2nd ✓" : "2nd —"}</td>
                  <td className="td text-xs">{s.signed}/{s.payees}</td>
                  <td className="td"><Badge tone={statusTone(s.status)}>{s.status}</Badge></td>
                  <td className="td text-right whitespace-nowrap">
                    <Link href={`/finance/payment-slips/${s.id}`} className="btn btn-sm">Open</Link>{" "}
                    <a href={`/print/payment-slip/${s.id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>New payment slip</SectionTitle>
      <form action={createPaymentSlipAction} className="card p-4 grid sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2">
          <Field label="Title"><input name="title" required className="input" placeholder="e.g. Airtime for data collectors — January 2023" /></Field>
        </div>
        <Field label="Category">
          <select name="category" className="select" defaultValue="Airtime">{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </Field>
        <Field label="Date"><input type="date" name="slipDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
        <Field label="Project (optional)">
          <select name="projectId" className="select" defaultValue=""><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.title}</option>)}</select>
        </Field>
        <Field label="Currency"><input name="currency" className="input" defaultValue={baseCcy} placeholder={baseCcy} style={{ width: 120 }} /></Field>
        <div className="sm:col-span-3">
          <Field label="Note (optional)"><input name="note" className="input" placeholder="Anything to record about this batch" /></Field>
        </div>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Create payment slip</button></div>
      </form>
      <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>{orgName} · payments are recorded here for approval and signing; post the cash movement to the ledger via a payment voucher when disbursed.</p>
    </div>
  );
}
