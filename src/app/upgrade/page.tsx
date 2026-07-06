import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { getOrgRequest, getPlatformSettings } from "@/server/services/billing";
import { q } from "@/server/db";
import { requestRenewalAction, submitPaymentProofAction, cancelRenewalAction, signOut } from "@/app/actions";
import { money, fmtDate } from "@/lib/format";
import { CONTACT_EMAIL, OPERATOR_NAME } from "@/lib/config";

const termLabel = (m: number) => (m % 12 === 0 ? `${m / 12} year${m === 12 ? "" : "s"}` : `${m} months`);

export default async function UpgradePage({ searchParams }: { searchParams: Promise<{ invoiced?: string; paid?: string; err?: string }> }) {
  const user = await requireUser();
  if (user.isSuperAdmin) redirect("/admin");
  const sp = await searchParams;
  const org = await getUserOrg(user.id);

  const ended = org?.plan === "trial" && org.trialEndsAt && new Date(org.trialEndsAt) < new Date();
  const suspended = org?.status === "suspended";
  const locked = ended || suspended;

  const req = org ? await getOrgRequest(org.id) : null;
  const settings = await getPlatformSettings();
  const billTo = org ? (await q<{ name: string; address: string | null; tin: string | null }>(`SELECT name, address, tin FROM organization WHERE id=$1`, [org.id]))[0] : null;
  const cur = settings.currency ?? "USD";
  const openStatuses = ["invoiced", "payment_submitted"];
  const hasInvoice = req && openStatuses.includes(req.status);
  const plans = [
    { months: 12, subtotal: settings.rate1yr, label: "1 year" },
    { months: 36, subtotal: settings.rate3yr, label: "3 years" },
    { months: 60, subtotal: settings.rate5yr, label: "5 years" },
  ];

  return (
    <div className="min-h-screen p-6 flex justify-center" style={{ background: "radial-gradient(140% 120% at 0% 0%, #15151d 0%, #0c0c11 55%, #0a0a0f 100%)" }}>
      <div className="w-full max-w-2xl">
        <div className="font-display text-xl font-semibold mb-1" style={{ color: "var(--brand)" }}>Project Strand</div>
        <div className="text-sm mb-5" style={{ color: "var(--muted)" }}>{org?.name}</div>

        <div className="card p-6">
          <h1 className="font-display text-xl font-semibold">
            {locked ? (suspended ? "Account suspended" : "Your free trial has ended") : "Upgrade your plan"}
          </h1>
          <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
            {locked
              ? "Access is paused until your plan is activated — your projects, budgets and documents are all kept safe. Choose a plan below; you'll get a signed invoice instantly, pay, and upload proof."
              : "Choose a paid plan below. You'll get a signed invoice instantly with payment details."}
          </p>
          {org?.trialEndsAt && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Trial end date: {new Date(org.trialEndsAt).toDateString()}</p>}

          {sp.invoiced && <div className="mt-3 text-sm rounded-lg p-3" style={{ background: "color-mix(in srgb, var(--ok) 12%, transparent)", color: "var(--ok)" }}>Your invoice was issued below and emailed to you. Pay via the details shown, then upload your proof of payment.</div>}
          {sp.paid && <div className="mt-3 text-sm rounded-lg p-3" style={{ background: "color-mix(in srgb, var(--ok) 12%, transparent)", color: "var(--ok)" }}>Proof of payment submitted. We'll activate your plan once it's confirmed — you'll be notified by email and in the app.</div>}
          {sp.err === "file" && <div className="mt-3 text-sm rounded-lg p-3" style={{ background: "color-mix(in srgb, var(--danger) 12%, transparent)", color: "var(--danger)" }}>Please attach a proof-of-payment file.</div>}

          {!org?.isOrgAdmin ? (
            <p className="text-sm mt-5" style={{ color: "var(--muted)" }}>Please ask your organisation administrator to choose a plan and complete payment.</p>
          ) : req && req.status === "payment_submitted" ? (
            <div className="mt-5 rounded-lg border p-4" style={{ borderColor: "var(--border)" }}>
              <div className="font-medium">Proof submitted — awaiting approval</div>
              <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>
                We received your proof of payment{req.paymentSubmittedAt ? ` on ${fmtDate(req.paymentSubmittedAt)}` : ""} for the {termLabel(req.termMonths)} plan ({req.invoiceNo}). We'll activate your subscription once confirmed.
              </div>
              <a href={`/print/subscription-invoice/${req.id}`} target="_blank" className="btn btn-sm mt-3">🖨 View / print invoice</a>
            </div>
          ) : hasInvoice && req && req.invoiceNo ? (
            <div className="mt-5">
              {/* Issued invoice */}
              <div className="rounded-lg border p-4" style={{ borderColor: "var(--border)" }}>
                <div className="flex flex-wrap items-start justify-between gap-3 pb-3 mb-3 border-b" style={{ borderColor: "var(--border)" }}>
                  <div className="min-w-0">
                    {settings.issuerLogoDataUrl && <img src={settings.issuerLogoDataUrl} alt="" style={{ maxHeight: 40, maxWidth: 140, objectFit: "contain", marginBottom: 4 }} />}
                    <div className="font-semibold" style={{ color: "var(--brand)" }}>{settings.issuerName || "Project Strand"}</div>
                    <div className="text-xs whitespace-pre-wrap" style={{ color: "var(--muted)" }}>{settings.issuerAddress || ""}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>{[settings.issuerEmail, settings.issuerPhone].filter(Boolean).join(" · ")}</div>
                    {settings.issuerTin && <div className="text-xs" style={{ color: "var(--muted)" }}>TIN: {settings.issuerTin}</div>}
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm" style={{ color: "var(--brand)" }}>{req.invoiceNo}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>{req.invoicedAt ? fmtDate(req.invoicedAt) : ""}</div>
                    <div className="text-[10px] uppercase tracking-wide mt-2" style={{ color: "var(--muted)" }}>Bill to</div>
                    <div className="text-sm font-semibold">{billTo?.name}</div>
                  </div>
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    <tr><td className="py-1" style={{ color: "var(--muted)" }}>Project Strand subscription — {termLabel(req.termMonths)}</td><td className="py-1 text-right">{money(req.subtotal ?? 0, req.currency ?? cur)}</td></tr>
                    <tr><td className="py-1" style={{ color: "var(--muted)" }}>VAT ({req.vatRate ?? 0}%)</td><td className="py-1 text-right">{money(req.vatAmount ?? 0, req.currency ?? cur)}</td></tr>
                    <tr style={{ borderTop: "1px solid var(--border)" }}><td className="py-1 font-semibold">Total due</td><td className="py-1 text-right font-semibold">{money(req.total ?? 0, req.currency ?? cur)}</td></tr>
                  </tbody>
                </table>
                <div className="grid sm:grid-cols-2 gap-3 mt-3">
                  <div><div className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Bank transfer</div><div className="text-sm whitespace-pre-wrap">{req.bankDetails || "—"}</div></div>
                  <div><div className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Mobile money</div><div className="text-sm whitespace-pre-wrap">{req.momoDetails || "—"}</div></div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>Authorised &amp; digitally issued by {settings.issuerName || "Project Strand"}.</span>
                  <a href={`/print/subscription-invoice/${req.id}`} target="_blank" className="btn btn-sm">🖨 Print / Download</a>
                </div>
              </div>

              {/* Upload proof */}
              <form action={submitPaymentProofAction} className="mt-4 grid gap-2">
                <input type="hidden" name="requestId" value={req.id} />
                <input type="hidden" name="from" value="upgrade" />
                <div className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--muted)" }}>Upload proof of payment</div>
                <input type="file" name="file" required className="input" />
                <div className="grid sm:grid-cols-2 gap-2">
                  <input name="paymentRef" className="input" placeholder="Payment reference (bank / MoMo)" />
                  <input name="note" className="input" placeholder="Note (optional)" />
                </div>
                <div className="flex justify-end"><button className="btn btn-primary" type="submit">Submit proof of payment</button></div>
              </form>
              <form action={cancelRenewalAction} className="mt-2 flex justify-end">
                <input type="hidden" name="requestId" value={req.id} />
                <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Cancel this request</button>
              </form>
            </div>
          ) : (
            /* Plan selection */
            <div className="mt-5 grid sm:grid-cols-3 gap-3">
              {plans.map((p) => {
                const vat = p.subtotal * (settings.vatRate / 100);
                const total = p.subtotal + vat;
                return (
                  <form key={p.months} action={requestRenewalAction} className="rounded-lg border p-4 flex flex-col" style={{ borderColor: "var(--border)" }}>
                    <input type="hidden" name="termMonths" value={p.months} />
                    <input type="hidden" name="from" value="upgrade" />
                    <div className="font-display text-lg font-semibold">{p.label}</div>
                    <div className="text-2xl font-bold mt-1">{money(p.subtotal, cur)}</div>
                    <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>+ VAT {settings.vatRate}% · {money(total, cur)} total</div>
                    <button className="btn btn-primary btn-sm mt-3" type="submit">Select this plan</button>
                  </form>
                );
              })}
            </div>
          )}

          <div className="mt-5 pt-4 flex items-center justify-between text-sm" style={{ borderTop: "1px solid var(--border)" }}>
            {!locked ? <Link href="/dashboard" className="hover:underline" style={{ color: "var(--brand)" }}>← Back to app</Link> : <span style={{ color: "var(--muted)" }}>Locked until activated</span>}
            <form action={signOut}><button className="hover:underline" style={{ color: "var(--muted)" }}>Sign out</button></form>
          </div>
        </div>

        <div className="text-center text-xs mt-6" style={{ color: "var(--muted)" }}>© {new Date().getFullYear()} {OPERATOR_NAME} · {CONTACT_EMAIL}</div>
      </div>
    </div>
  );
}
