import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFinanceOrg } from "../../_guard";
import { getAgreement, listTranches, listReceipts, RECEIPT_METHODS } from "@/server/services/funding";
import { PageHeader, SectionTitle, Field, Stat, StatusBadge, Badge, Empty, ProgressBar } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { addTrancheAction, deleteTrancheAction, recordReceiptAction, deleteFundingReceiptAction, closeAgreementAction, deleteAgreementAction } from "@/app/actions";

const trancheTone = (s: string) => (s === "received" ? "ok" : s === "overdue" ? "danger" : s === "partial" ? "warn" : "muted");

export default async function AgreementDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const { id } = await params;
  const sp = await searchParams;
  const a = await getAgreement(orgId, id);
  if (!a) notFound();
  const [tranches, receipts] = await Promise.all([listTranches(orgId, id), listReceipts(orgId, id)]);
  const ccy = a.currency;
  const closed = a.status === "closed";
  const today = new Date().toISOString().slice(0, 10);
  const pct = a.totalAmount > 0 ? Math.min(Math.round((a.received / a.totalAmount) * 100), 100) : 0;
  const scheduled = tranches.reduce((s, t) => s + t.amount, 0);

  return (
    <div className="max-w-4xl">
      <PageHeader title={a.donor} subtitle={`${a.title} · ${orgName}`} actions={<Link href="/finance/funding" className="btn btn-sm">← Agreements</Link>} />
      {sp.err === "amount" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Enter a valid amount.</div>}
      {sp.err === "label" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A tranche label is required.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <StatusBadge status={a.status} />
        {a.reference && <span className="text-sm" style={{ color: "var(--muted)" }}>Ref: {a.reference}</span>}
        {a.projectTitle && <Badge tone="info">{a.projectTitle}</Badge>}
        {(a.startDate || a.endDate) && <span className="text-sm" style={{ color: "var(--muted)" }}>{a.startDate ? fmtDate(a.startDate) : "…"} – {a.endDate ? fmtDate(a.endDate) : "…"}</span>}
        {a.fileKey && <a href={`/api/funding-files/agreement/${a.id}`} className="text-sm hover:underline" style={{ color: "var(--brand)" }}>📎 Agreement</a>}
        <div className="ml-auto flex items-center gap-2">
          <form action={closeAgreementAction}><input type="hidden" name="agreementId" value={a.id} /><input type="hidden" name="reopen" value={closed ? "1" : "0"} /><button className="btn btn-sm" type="submit">{closed ? "Reopen" : "Close"}</button></form>
          <form action={deleteAgreementAction}><input type="hidden" name="agreementId" value={a.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete</button></form>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
        <Stat label="Committed" value={money(a.totalAmount, ccy)} />
        <Stat label="Received" value={money(a.received, ccy)} tone="ok" />
        <Stat label="Outstanding" value={money(a.outstanding, ccy)} tone={a.outstanding ? "warn" : undefined} />
        <Stat label="Focal person" value={a.focalPerson ?? "—"} />
      </div>
      <div className="card p-4 mb-5"><div className="flex items-center justify-between text-sm mb-1"><span className="font-medium">Funding received</span><span style={{ color: "var(--muted)" }}>{pct}%</span></div><ProgressBar value={pct} /></div>

      {/* Tranche schedule */}
      <div className="flex items-center justify-between"><SectionTitle>Tranche schedule</SectionTitle>{scheduled !== a.totalAmount && tranches.length > 0 && <span className="text-xs" style={{ color: "var(--warn)" }}>Scheduled {money(scheduled, ccy)} ≠ committed {money(a.totalAmount, ccy)}</span>}</div>
      <div className="mt-2 mb-5">
        {tranches.length === 0 ? <Empty title="No tranches" hint="Add the expected disbursement schedule below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Tranche</th><th className="th text-left">Expected</th><th className="th text-right">Amount</th><th className="th text-right">Received</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
              <tbody>
                {tranches.map((t) => (
                  <tr key={t.id}>
                    <td className="td"><div className="font-medium">{t.label}</div>{t.condition && <div className="text-xs" style={{ color: "var(--muted)" }}>{t.condition}</div>}</td>
                    <td className="td whitespace-nowrap">{t.expectedDate ? fmtDate(t.expectedDate) : "—"}</td>
                    <td className="td text-right whitespace-nowrap">{money(t.amount, ccy)}</td>
                    <td className="td text-right whitespace-nowrap">{money(t.received, ccy)}</td>
                    <td className="td"><Badge tone={trancheTone(t.status)}>{label(t.status)}</Badge></td>
                    <td className="td text-right">{!closed && <form action={deleteTrancheAction}><input type="hidden" name="trancheId" value={t.id} /><input type="hidden" name="agreementId" value={a.id} /><button className="btn btn-sm" type="submit" title="Remove">✕</button></form>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Receipts ledger */}
      <SectionTitle>Income received</SectionTitle>
      <div className="mt-2 mb-5">
        {receipts.length === 0 ? <Empty title="No receipts" hint="Record grant income as it arrives below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Date</th><th className="th text-right">Amount</th><th className="th text-left">Tranche</th><th className="th text-left">Method / ref</th><th className="th text-left">By</th><th className="th" /></tr></thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td className="td whitespace-nowrap">{fmtDate(r.receiptDate)}</td>
                    <td className="td text-right whitespace-nowrap" style={{ color: "var(--ok)" }}>{money(r.amount, ccy)}</td>
                    <td className="td">{r.trancheLabel ?? "—"}</td>
                    <td className="td">{[r.method, r.reference].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="td">{r.recordedByName ?? "—"}</td>
                    <td className="td text-right">
                      <div className="flex items-center justify-end gap-2">
                        {r.fileKey && <a href={`/api/funding-files/receipt/${r.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>📎</a>}
                        {!closed && <form action={deleteFundingReceiptAction}><input type="hidden" name="receiptId" value={r.id} /><input type="hidden" name="agreementId" value={a.id} /><button className="btn btn-sm" type="submit" title="Remove">✕</button></form>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!closed && (
        <div className="grid md:grid-cols-2 gap-5">
          <div className="card p-4">
            <SectionTitle>Add tranche</SectionTitle>
            <form action={addTrancheAction} className="grid sm:grid-cols-2 gap-3 mt-2">
              <input type="hidden" name="agreementId" value={a.id} />
              <Field label="Label *"><input name="label" required className="input input-sm" placeholder="e.g. Tranche 1" /></Field>
              <Field label="Expected date"><input name="expectedDate" type="date" className="input input-sm" /></Field>
              <Field label="Amount"><input name="amount" type="number" step="0.01" min="0" className="input input-sm" /></Field>
              <Field label="Condition"><input name="condition" className="input input-sm" placeholder="Milestone for release" /></Field>
              <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Add tranche</button></div>
            </form>
          </div>

          <div className="card p-4">
            <SectionTitle>Record income</SectionTitle>
            <form action={recordReceiptAction} className="grid sm:grid-cols-2 gap-3 mt-2">
              <input type="hidden" name="agreementId" value={a.id} />
              <Field label="Date"><input name="receiptDate" type="date" defaultValue={today} className="input input-sm" /></Field>
              <Field label="Amount *"><input name="amount" type="number" step="0.01" min="0" required className="input input-sm" /></Field>
              <Field label="Against tranche"><select name="trancheId" className="select select-sm"><option value="">— (general)</option>{tranches.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>
              <Field label="Method"><select name="method" className="select select-sm"><option value="">—</option>{RECEIPT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</select></Field>
              <Field label="Reference"><input name="reference" className="input input-sm" placeholder="Bank / transfer ref" /></Field>
              <Field label="Remittance advice"><input name="file" type="file" className="input input-sm" /></Field>
              <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Record income</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
