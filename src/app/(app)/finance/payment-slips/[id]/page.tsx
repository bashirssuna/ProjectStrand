import Link from "next/link";
import { redirect } from "next/navigation";
import { requireFinanceOrg } from "../../_guard";
import { getSlip, getPayees } from "@/server/services/payment-slips";
import { PageHeader, SectionTitle, Field, Badge, Empty, Stat } from "@/components/ui";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { SignField } from "@/components/sign-field";
import {
  addSlipPayeeAction, bulkAddSlipPayeesAction, deleteSlipPayeeAction,
  signSlipFinanceAction, signSlipPIAction, sendSlipSigningLinksAction, setSlipStatusAction,
} from "@/app/actions";

export default async function SlipDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string; err?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { orgId } = await requireFinanceOrg();
  const slip = await getSlip(id, orgId);
  if (!slip) redirect("/finance/payment-slips");
  const payees = await getPayees(id);
  const total = payees.reduce((s, p) => s + p.amount, 0);
  const signedCount = payees.filter((p) => p.signed).length;
  const emailable = payees.filter((p) => p.email && !p.signed).length;
  const c = slip.currency;

  return (
    <div className="max-w-5xl">
      <PageHeader title={`${slip.title}`} subtitle={`${slip.number} · ${slip.category ?? "Payment"} · ${fmtDate(slip.slipDate)}${slip.project ? ` · ${slip.project}` : ""}`}
        actions={<div className="flex gap-2">
          <a href={`/print/payment-slip/${id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨 Print</a>
          <Link href="/finance/payment-slips" className="btn btn-sm">← All slips</Link>
        </div>} />

      {sp.sent && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Signing links emailed to {sp.sent} payee{sp.sent === "1" ? "" : "s"}.</div>}
      {sp.err === "forbidden" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Only the project PI/Co-PI or an org admin can sign as PI.</div>}
      {sp.err === "sign" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Please draw or type a signature before submitting.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Payees" value={String(payees.length)} />
        <Stat label="Total" value={money(total, c)} />
        <Stat label="Signed by payees" value={`${signedCount}/${payees.length}`} />
        <Stat label="Status" value={slip.status} />
      </div>

      {/* Approval signatures */}
      <SectionTitle>Approval</SectionTitle>
      <div className="grid sm:grid-cols-2 gap-4 mb-6">
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Finance</div>
          {slip.financeSignature ? (
            <div>
              <img src={slip.financeSignature} alt="Finance signature" style={{ maxHeight: 70 }} />
              <div className="text-sm mt-1">{slip.financeSignedName}</div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>Signed {slip.financeSignedAt ? fmtDateTime(slip.financeSignedAt) : ""}</div>
            </div>
          ) : (
            <form action={signSlipFinanceAction}>
              <input type="hidden" name="slipId" value={id} />
              <SignField name="signature" />
              <div className="mt-2"><button className="btn btn-sm btn-primary" type="submit">Approve &amp; sign as Finance</button></div>
            </form>
          )}
        </div>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Principal Investigator</div>
          {slip.piSignature ? (
            <div>
              <img src={slip.piSignature} alt="PI signature" style={{ maxHeight: 70 }} />
              <div className="text-sm mt-1">{slip.piSignedName}</div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>Signed {slip.piSignedAt ? fmtDateTime(slip.piSignedAt) : ""}</div>
            </div>
          ) : (
            <form action={signSlipPIAction}>
              <input type="hidden" name="slipId" value={id} />
              <SignField name="signature" />
              <div className="mt-2"><button className="btn btn-sm btn-primary" type="submit">Approve &amp; sign as PI</button></div>
            </form>
          )}
        </div>
      </div>

      {/* Payees */}
      <SectionTitle action={
        <div className="flex items-center gap-2">
          {emailable > 0 && (slip.financeSignature || slip.piSignature) && (
            <form action={sendSlipSigningLinksAction}><input type="hidden" name="slipId" value={id} />
              <button className="btn btn-sm btn-primary" type="submit">✉ Email signing links ({emailable})</button>
            </form>
          )}
          {slip.status !== "disbursed" && (
            <form action={setSlipStatusAction}><input type="hidden" name="slipId" value={id} /><input type="hidden" name="status" value="disbursed" />
              <button className="btn btn-sm" type="submit">Mark disbursed</button>
            </form>
          )}
        </div>
      }>People to be paid</SectionTitle>

      {payees.length === 0 ? (
        <Empty title="No payees yet" hint="Add people individually or paste a list below." />
      ) : (
        <div className="card overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">No.</th><th className="th text-left">Name</th><th className="th text-left">Phone</th>
              <th className="th text-left">Email</th><th className="th text-left">Designation</th><th className="th text-left">Payment for</th>
              <th className="th text-right">Amount</th><th className="th text-left">Signature</th><th className="th"></th>
            </tr></thead>
            <tbody>
              {payees.map((p) => (
                <tr key={p.id}>
                  <td className="td">{p.idx}</td>
                  <td className="td">{p.name}</td>
                  <td className="td">{p.phone ?? "—"}</td>
                  <td className="td text-xs">{p.email ?? "—"}</td>
                  <td className="td">{p.designation ?? "—"}</td>
                  <td className="td">{p.paymentFor ?? slip.category ?? "—"}</td>
                  <td className="td text-right whitespace-nowrap">{money(p.amount, c)}</td>
                  <td className="td">
                    {p.signed && p.signature
                      ? <span title={p.signedAt ? fmtDateTime(p.signedAt) : ""}><img src={p.signature} alt="signature" style={{ maxHeight: 34 }} /></span>
                      : p.linkSentAt ? <Badge tone="info">link sent</Badge> : <span className="text-xs" style={{ color: "var(--muted)" }}>not signed</span>}
                  </td>
                  <td className="td text-right">
                    <form action={deleteSlipPayeeAction}><input type="hidden" name="slipId" value={id} /><input type="hidden" name="payeeId" value={p.id} />
                      <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }} title="Remove">✕</button>
                    </form>
                  </td>
                </tr>
              ))}
              <tr>
                <td className="td" /><td className="td font-semibold" colSpan={5}>Total</td>
                <td className="td text-right font-semibold whitespace-nowrap">{money(total, c)}</td><td className="td" /><td className="td" />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="text-sm font-semibold mb-2">Add a person</div>
          <form action={addSlipPayeeAction} className="grid grid-cols-2 gap-2">
            <input type="hidden" name="slipId" value={id} />
            <Field label="Name"><input name="name" required className="input" /></Field>
            <Field label="Phone"><input name="phone" className="input" /></Field>
            <Field label="Email"><input name="email" type="email" className="input" /></Field>
            <Field label="Designation"><input name="designation" className="input" placeholder="e.g. Research Assistant" /></Field>
            <Field label="Payment for"><input name="paymentFor" className="input" placeholder={slip.category ?? "e.g. Airtime"} /></Field>
            <Field label="Amount"><input name="amount" type="number" step="any" min="0" className="input" /></Field>
            <div className="col-span-2 flex justify-end"><button className="btn btn-sm btn-primary" type="submit">Add person</button></div>
          </form>
        </div>
        <div className="card p-4">
          <div className="text-sm font-semibold mb-2">Paste a list (bulk)</div>
          <form action={bulkAddSlipPayeesAction}>
            <input type="hidden" name="slipId" value={id} />
            <textarea name="rows" className="textarea w-full font-mono text-xs" rows={7}
              placeholder={"One person per line: Name, Phone, Email, Designation, Payment for, Amount\nNagawa Rachel, 0705036199, rachel@x.org, Research Assistant, Airtime, 50000\nNalubega Madinah\t0705554838\tmadinah@x.org\tRA\tData\t50000"} />
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs" style={{ color: "var(--muted)" }}>Tab or comma separated. Paste straight from a spreadsheet.</span>
              <button className="btn btn-sm btn-primary" type="submit">Add all</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
