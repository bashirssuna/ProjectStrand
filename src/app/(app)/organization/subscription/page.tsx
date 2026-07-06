import Link from "next/link";
import { requireOrgAdmin } from "../_guard";
import { getUserOrg } from "@/server/services/accounts";
import { getOrgRequest, getPlatformSettings } from "@/server/services/billing";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge } from "@/components/ui";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { requestRenewalAction, submitPaymentProofAction, cancelRenewalAction } from "@/app/actions";

const termLabel = (m: number) => m % 12 === 0 ? `${m / 12} year${m === 12 ? "" : "s"}` : `${m} months`;

export default async function SubscriptionPage({ searchParams }: { searchParams: Promise<{ requested?: string; invoiced?: string; paid?: string; cancelled?: string; err?: string }> }) {
  const { orgId, orgName, userId } = await requireOrgAdmin();
  const sp = await searchParams;
  const org = await getUserOrg(userId);
  const req = await getOrgRequest(orgId);
  const issuer = await getPlatformSettings();
  const billTo = (await q<{ name: string; address: string | null; tin: string | null }>(`SELECT name, address, tin FROM organization WHERE id=$1`, [orgId]))[0];

  const subLeft = org?.plan === "active" && org.subscriptionEndsAt ? Math.ceil((new Date(org.subscriptionEndsAt).getTime() - Date.now()) / 86400000) : null;
  const trialLeft = org?.plan === "trial" && org.trialEndsAt ? Math.ceil((new Date(org.trialEndsAt).getTime() - Date.now()) / 86400000) : null;
  const openStatuses = ["requested", "invoiced", "payment_submitted"];
  const hasOpen = req && openStatuses.includes(req.status);

  return (
    <div className="max-w-3xl">
      <PageHeader title="Subscription" subtitle={`Renewals & billing · ${orgName}`} actions={<Link href="/organization" className="btn btn-sm">← Organisation</Link>} />

      {sp.requested && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Renewal requested. The Project Strand team will send you an invoice shortly.</div>}
      {sp.invoiced && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Your invoice has been issued below and emailed to you. Pay via the details shown, then upload your proof of payment.</div>}
      {sp.paid && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Proof of payment submitted. We&apos;ll activate your renewal once it&apos;s confirmed.</div>}
      {sp.cancelled && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>Renewal request cancelled.</div>}
      {sp.err === "file" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Please attach a proof-of-payment file.</div>}
      {sp.err === "state" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>That request is no longer awaiting payment.</div>}

      {/* Current status */}
      <div className="card p-4 mb-5">
        <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>Current status</div>
        {org?.plan === "active" && org.subscriptionEndsAt ? (
          <>
            <div className="font-display text-lg font-semibold">{subLeft !== null && subLeft < 0 ? <span style={{ color: "var(--danger)" }}>Expired</span> : <>{subLeft} day{subLeft === 1 ? "" : "s"} until renewal</>}</div>
            <div className="text-sm" style={{ color: "var(--muted)" }}>Paid plan · {subLeft !== null && subLeft < 0 ? "expired" : "renews"} {fmtDate(org.subscriptionEndsAt)}</div>
          </>
        ) : org?.plan === "trial" ? (
          <>
            <div className="font-display text-lg font-semibold">{trialLeft !== null && trialLeft < 0 ? <span style={{ color: "var(--danger)" }}>Trial ended</span> : <>Free trial · {trialLeft} day{trialLeft === 1 ? "" : "s"} left</>}</div>
            <div className="text-sm" style={{ color: "var(--muted)" }}>Request a renewal below to move onto a paid plan.</div>
          </>
        ) : (
          <div className="font-display text-lg font-semibold">No active subscription</div>
        )}
      </div>

      {/* Active request flow */}
      {hasOpen && req && (
        <div className="mb-5">
          <SectionTitle>Your renewal request</SectionTitle>
          <div className="card p-4">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <div className="font-medium">{termLabel(req.termMonths)} renewal</div>
              <Badge tone={req.status === "invoiced" ? "info" : req.status === "payment_submitted" ? "warn" : "muted"}>
                {req.status === "requested" ? "Awaiting invoice" : req.status === "invoiced" ? "Invoice issued — pay & upload proof" : "Proof submitted — awaiting approval"}
              </Badge>
            </div>

            {req.status === "requested" && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>Requested {fmtDateTime(req.requestedAt)}. We&apos;ll email you an invoice with payment details.</p>
            )}

            {/* Invoice (issued) */}
            {(req.status === "invoiced" || req.status === "payment_submitted") && req.invoiceNo && (
              <div className="border rounded-lg p-3 mt-2" style={{ borderColor: "var(--border)" }}>
                <div className="flex flex-wrap items-start justify-between gap-3 mb-3 pb-3 border-b" style={{ borderColor: "var(--border)" }}>
                  <div className="min-w-0">
                    {issuer.issuerLogoDataUrl && <img src={issuer.issuerLogoDataUrl} alt="" style={{ maxHeight: 40, maxWidth: 140, objectFit: "contain", marginBottom: 4 }} />}
                    <div className="font-semibold" style={{ color: "var(--brand)" }}>{issuer.issuerName || "Project Strand"}</div>
                    <div className="text-xs whitespace-pre-wrap" style={{ color: "var(--muted)" }}>{issuer.issuerAddress || ""}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>{[issuer.issuerEmail, issuer.issuerPhone].filter(Boolean).join(" · ")}</div>
                    {issuer.issuerTin && <div className="text-xs" style={{ color: "var(--muted)" }}>TIN: {issuer.issuerTin}</div>}
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--muted)" }}>Bill to</div>
                    <div className="font-semibold">{billTo?.name}</div>
                    {billTo?.address && <div className="text-xs whitespace-pre-wrap" style={{ color: "var(--muted)" }}>{billTo.address}</div>}
                    {billTo?.tin && <div className="text-xs" style={{ color: "var(--muted)" }}>TIN: {billTo.tin}</div>}
                  </div>
                </div>
                <div className="flex items-center justify-between mb-2">
                  <div className="font-mono text-sm" style={{ color: "var(--brand)" }}>{req.invoiceNo}</div>
                  <div className="text-xs" style={{ color: "var(--muted)" }}>{req.invoicedAt ? fmtDate(req.invoicedAt) : ""}</div>
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    <tr><td className="py-1" style={{ color: "var(--muted)" }}>Subtotal</td><td className="py-1 text-right">{money(req.subtotal ?? 0, req.currency ?? "USD")}</td></tr>
                    <tr><td className="py-1" style={{ color: "var(--muted)" }}>VAT ({req.vatRate ?? 0}%)</td><td className="py-1 text-right">{money(req.vatAmount ?? 0, req.currency ?? "USD")}</td></tr>
                    <tr style={{ borderTop: "1px solid var(--border)" }}><td className="py-1 font-semibold">Total due</td><td className="py-1 text-right font-semibold">{money(req.total ?? 0, req.currency ?? "USD")}</td></tr>
                  </tbody>
                </table>
                <div className="grid sm:grid-cols-2 gap-3 mt-3">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Bank transfer</div>
                    <div className="text-sm whitespace-pre-wrap">{req.bankDetails || "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Mobile money</div>
                    <div className="text-sm whitespace-pre-wrap">{req.momoDetails || "—"}</div>
                  </div>
                </div>
                {req.invoiceNote && <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>{req.invoiceNote}</p>}
                <div className="flex items-center justify-between gap-2 mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>Authorised &amp; digitally issued by {issuer.issuerName || "Project Strand"}.</span>
                  <a href={`/print/subscription-invoice/${req.id}`} target="_blank" className="btn btn-sm">🖨 Print / Download</a>
                </div>
              </div>
            )}

            {/* Upload proof (invoiced) */}
            {req.status === "invoiced" && (
              <form action={submitPaymentProofAction} className="mt-3 grid gap-2" encType="multipart/form-data">
                <input type="hidden" name="requestId" value={req.id} />
                <div className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--muted)" }}>Upload proof of payment</div>
                <input type="file" name="file" required className="input" />
                <div className="grid sm:grid-cols-2 gap-2">
                  <Field label="Payment reference"><input name="paymentRef" className="input" placeholder="Bank / MoMo transaction ref" /></Field>
                  <Field label="Note (optional)"><input name="note" className="input" /></Field>
                </div>
                <div className="flex justify-end"><button className="btn btn-primary" type="submit">Submit proof of payment</button></div>
              </form>
            )}

            {/* Proof submitted */}
            {req.status === "payment_submitted" && (
              <div className="mt-3 text-sm">
                <div style={{ color: "var(--ok)" }}>Proof of payment submitted{req.paymentSubmittedAt ? ` on ${fmtDate(req.paymentSubmittedAt)}` : ""}.</div>
                <div style={{ color: "var(--muted)" }}>{req.paymentFileName ? `File: ${req.paymentFileName}` : ""}{req.paymentRef ? ` · Ref: ${req.paymentRef}` : ""}</div>
                <div className="mt-1" style={{ color: "var(--muted)" }}>Awaiting confirmation from the Project Strand team.</div>
              </div>
            )}

            {/* Cancel (still pending) */}
            {(req.status === "requested" || req.status === "invoiced") && (
              <form action={cancelRenewalAction} className="mt-3">
                <input type="hidden" name="requestId" value={req.id} />
                <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Cancel request</button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Request renewal (no open request) */}
      {!hasOpen && (
        <div>
          {req && req.status === "rejected" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Your last request needs attention{req.rejectReason ? `: ${req.rejectReason}` : ""}. You can submit a new one below.</div>}
          {req && req.status === "approved" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Your last renewal was activated{req.completedAt ? ` on ${fmtDate(req.completedAt)}` : ""}. Thank you!</div>}
          <SectionTitle>Choose a plan</SectionTitle>
          <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>Pick a term below. As soon as you select one, a signed invoice is issued instantly (and emailed to you) with bank and mobile-money payment details. After paying, upload your proof here and we&apos;ll activate it.</p>
          <div className="grid sm:grid-cols-3 gap-3">
            {[{ months: 12, subtotal: issuer.rate1yr, label: "1 year" }, { months: 36, subtotal: issuer.rate3yr, label: "3 years" }, { months: 60, subtotal: issuer.rate5yr, label: "5 years" }].map((p) => {
              const vat = p.subtotal * (issuer.vatRate / 100);
              const total = p.subtotal + vat;
              return (
                <form key={p.months} action={requestRenewalAction} className="card p-4 flex flex-col">
                  <input type="hidden" name="termMonths" value={p.months} />
                  <div className="font-display text-lg font-semibold">{p.label}</div>
                  <div className="text-2xl font-bold mt-1">{money(p.subtotal, issuer.currency)}</div>
                  <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>+ VAT {issuer.vatRate}% · {money(total, issuer.currency)} total</div>
                  <button className="btn btn-primary btn-sm mt-3" type="submit">Select this plan</button>
                </form>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
