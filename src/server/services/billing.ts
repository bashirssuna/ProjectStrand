import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { sendEmail } from "@/server/email";
import { writeAudit, notify } from "@/server/services/audit";
import { SYSTEM_ADMIN_EMAIL } from "@/lib/config";

const round2 = (n: number) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

function addMonths(d: Date, m: number): Date { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; }
const fmt = (iso: string | Date) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const money = (n: number, c: string) => `${c} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shell = (inner: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1c1917">
     <div style="border-bottom:3px solid #9a7b4f;padding:14px 0;font-size:18px;font-weight:700;color:#9a7b4f">Project Strand</div>
     <div style="padding:18px 0;font-size:14px;line-height:1.6">${inner}</div>
     <div style="border-top:1px solid #e7e5e4;padding-top:12px;font-size:12px;color:#78716c">Project Strand — research &amp; grant operations platform.</div>
   </div>`;

const esc = (s: unknown) => String(s ?? "").replace(/</g, "&lt;");

// "From" (platform issuer) + "Bill to" (organisation) header for invoices/receipts.
function letterhead(
  issuer: { issuerName: string | null; issuerTin: string | null; issuerAddress: string | null; issuerEmail: string | null; issuerPhone: string | null; issuerWebsite: string | null; issuerLogoDataUrl: string | null },
  org: { name: string; address: string | null; tin: string | null; email: string | null; phone: string | null }
): string {
  const lines = (arr: (string | null)[]) => arr.filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join("");
  const issuerName = issuer.issuerName || "Project Strand";
  const logo = issuer.issuerLogoDataUrl ? `<img src="${issuer.issuerLogoDataUrl}" alt="" style="max-height:54px;max-width:160px;object-fit:contain;margin-bottom:6px"/>` : "";
  const issuerLines = lines([issuer.issuerAddress, [issuer.issuerEmail, issuer.issuerPhone].filter(Boolean).join(" · ") || null, issuer.issuerWebsite, issuer.issuerTin ? `TIN: ${issuer.issuerTin}` : null]);
  const billLines = lines([org.address, [org.email, org.phone].filter(Boolean).join(" · ") || null, org.tin ? `TIN: ${org.tin}` : null]);
  return `<table style="width:100%;border-collapse:collapse;margin-bottom:14px"><tr>
      <td style="vertical-align:top">${logo}<div style="font-weight:700;font-size:15px;color:#9a7b4f">${esc(issuerName)}</div><div style="font-size:12px;color:#57534e">${issuerLines}</div></td>
      <td style="vertical-align:top;text-align:right"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#a8a29e">Bill to</div><div style="font-weight:700">${esc(org.name)}</div><div style="font-size:12px;color:#57534e">${billLines}</div></td>
    </tr></table>`;
}

type OrgBillTo = { name: string; address: string | null; tin: string | null; email: string | null; phone: string | null };
async function orgBillTo(orgId: string): Promise<OrgBillTo> {
  return (await one<OrgBillTo>(`SELECT name, address, tin, email, phone FROM organization WHERE id=$1`, [orgId]))
    ?? { name: "Organisation", address: null, tin: null, email: null, phone: null };
}

// The admin email for an organisation (its org_admin, else the earliest member).
export async function orgAdminEmail(orgId: string): Promise<string | null> {
  const admin = await one<{ email: string }>(
    `SELECT u.email FROM org_membership m JOIN app_user u ON u.id=m.user_id JOIN role r ON r.id=m.role_id
     WHERE m.org_id=$1 AND r.key='org_admin' ORDER BY m.created_at LIMIT 1`, [orgId]
  );
  if (admin?.email) return admin.email;
  const any = await one<{ email: string }>(
    `SELECT u.email FROM org_membership m JOIN app_user u ON u.id=m.user_id WHERE m.org_id=$1 ORDER BY m.created_at LIMIT 1`, [orgId]
  );
  return any?.email ?? null;
}

// Activate or renew a paid subscription for a fixed term (months). Renewing
// before expiry stacks the new term onto the remaining time.
export async function activateSubscription(orgId: string, termMonths: number, by?: { id: string; name: string }): Promise<string> {
  const org = await one<{ endsAt: string | null }>(`SELECT subscription_ends_at AS "endsAt" FROM organization WHERE id=$1`, [orgId]);
  const now = new Date();
  const base = org?.endsAt && new Date(org.endsAt) > now ? new Date(org.endsAt) : now;
  const end = addMonths(base, termMonths);
  await q(`UPDATE organization SET plan='active', status='active', subscription_term_months=$2, subscription_ends_at=$3, updated_at=now() WHERE id=$1`,
    [orgId, termMonths, end.toISOString()]);
  await writeAudit({ orgId, userId: by?.id, action: "update", entity: "organization", entityId: orgId, after: { activated: true, termMonths, endsAt: end.toISOString() } });
  return end.toISOString();
}

// Record a subscription payment, extend the subscription by the paid term, and
// return the payment id (a receipt number is assigned).
export async function recordSubscriptionPayment(input: {
  orgId: string; amount: number; currency: string; termMonths: number; reference?: string; note?: string; paidOn?: string; by?: { id: string; name: string };
}): Promise<string> {
  const now = new Date();
  const org = await one<{ endsAt: string | null }>(`SELECT subscription_ends_at AS "endsAt" FROM organization WHERE id=$1`, [input.orgId]);
  const base = org?.endsAt && new Date(org.endsAt) > now ? new Date(org.endsAt) : now;
  const end = addMonths(base, input.termMonths);
  const count = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM subscription_payment`))?.c ?? 0;
  const receiptNo = `RCPT-${String(count + 1).padStart(4, "0")}`;
  const pid = id("pay");
  await q(`INSERT INTO subscription_payment (id, org_id, receipt_no, amount, currency, term_months, period_start, period_end, reference, note, paid_on, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [pid, input.orgId, receiptNo, input.amount, input.currency, input.termMonths,
     base.toISOString().slice(0, 10), end.toISOString().slice(0, 10), input.reference ?? null, input.note ?? null,
     input.paidOn ?? now.toISOString().slice(0, 10), input.by?.id ?? null, input.by?.name ?? null]);
  await q(`UPDATE organization SET plan='active', status='active', subscription_term_months=$2, subscription_ends_at=$3, updated_at=now() WHERE id=$1`,
    [input.orgId, input.termMonths, end.toISOString()]);
  await writeAudit({ orgId: input.orgId, userId: input.by?.id, action: "create", entity: "subscription_payment", entityId: pid, after: { amount: input.amount, receiptNo } });
  return pid;
}

type PaymentRow = { id: string; orgId: string; orgName: string; receiptNo: string | null; amount: number; currency: string; termMonths: number; periodStart: string | null; periodEnd: string | null; reference: string | null; paidOn: string };

// Email a formatted receipt for a recorded payment.
export async function sendReceiptEmail(paymentId: string): Promise<{ status: "sent" | "failed"; error?: string }> {
  const p = await one<PaymentRow>(
    `SELECT sp.id, sp.org_id AS "orgId", o.name AS "orgName", sp.receipt_no AS "receiptNo", sp.amount::float AS amount,
            sp.currency, sp.term_months AS "termMonths", sp.period_start AS "periodStart", sp.period_end AS "periodEnd",
            sp.reference, sp.paid_on AS "paidOn"
     FROM subscription_payment sp JOIN organization o ON o.id=sp.org_id WHERE sp.id=$1`, [paymentId]
  );
  if (!p) return { status: "failed", error: "Payment not found" };
  const to = await orgAdminEmail(p.orgId);
  if (!to) return { status: "failed", error: "No organisation email on file" };
  const org = await orgBillTo(p.orgId);
  const settings = await getPlatformSettings();
  const years = p.termMonths % 12 === 0 ? `${p.termMonths / 12} year${p.termMonths === 12 ? "" : "s"}` : `${p.termMonths} months`;
  const html = shell(
    letterhead(settings, org) +
    `<p style="font-size:16px;font-weight:700">Payment receipt</p>
     <p>Thank you, <strong>${esc(p.orgName)}</strong>. We confirm receipt of your Project Strand subscription payment.</p>
     <table style="width:100%;border-collapse:collapse;margin:12px 0">
       <tr><td style="padding:6px 0;color:#78716c">Receipt no.</td><td style="text-align:right;font-weight:600">${p.receiptNo ?? "—"}</td></tr>
       <tr><td style="padding:6px 0;color:#78716c">Amount paid</td><td style="text-align:right;font-weight:600">${money(p.amount, p.currency)}</td></tr>
       <tr><td style="padding:6px 0;color:#78716c">Subscription term</td><td style="text-align:right">${years}</td></tr>
       <tr><td style="padding:6px 0;color:#78716c">Covers</td><td style="text-align:right">${p.periodStart ? fmt(p.periodStart) : ""} – ${p.periodEnd ? fmt(p.periodEnd) : ""}</td></tr>
       <tr><td style="padding:6px 0;color:#78716c">Paid on</td><td style="text-align:right">${fmt(p.paidOn)}</td></tr>
       ${p.reference ? `<tr><td style="padding:6px 0;color:#78716c">Reference</td><td style="text-align:right">${p.reference}</td></tr>` : ""}
     </table>
     <p>Your subscription is active until <strong>${p.periodEnd ? fmt(p.periodEnd) : ""}</strong>.</p>`
  );
  const res = await sendEmail({ to, subject: `Receipt ${p.receiptNo} — Project Strand subscription`, html });
  if (res.status === "sent") await q(`UPDATE subscription_payment SET receipt_sent_at=now() WHERE id=$1`, [paymentId]);
  return res;
}

// Broadcast an announcement (maintenance / upgrades) to organisation admins.
export async function sendAnnouncement(input: { subject: string; body: string; audience: "all" | "active" | "trial"; by?: { id: string; name: string } }): Promise<{ recipients: number; sent: number }> {
  const filter = input.audience === "active" ? `AND o.plan='active'` : input.audience === "trial" ? `AND o.plan='trial'` : ``;
  const orgs = await q<{ id: string; name: string; email: string | null }>(
    `SELECT o.id, o.name,
            (SELECT u.email FROM org_membership m JOIN app_user u ON u.id=m.user_id JOIN role r ON r.id=m.role_id
             WHERE m.org_id=o.id AND r.key='org_admin' ORDER BY m.created_at LIMIT 1) AS email
     FROM organization o WHERE 1=1 ${filter}`
  );
  const bodyHtml = input.body.split(/\n/).map((l) => l.trim() ? `<p>${l.replace(/</g, "&lt;")}</p>` : "").join("");
  let sent = 0; let recipients = 0;
  for (const o of orgs) {
    if (!o.email) continue;
    recipients++;
    const html = shell(`<p style="font-size:16px;font-weight:700">${input.subject.replace(/</g, "&lt;")}</p>${bodyHtml}<p style="color:#78716c">— The Project Strand team</p>`);
    const res = await sendEmail({ to: o.email, subject: input.subject, html });
    if (res.status === "sent") sent++;
  }
  await q(`INSERT INTO platform_announcement (id, subject, body, audience, recipients, sent_count, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("ann"), input.subject, input.body, input.audience, recipients, sent, input.by?.id ?? null, input.by?.name ?? null]);
  return { recipients, sent };
}

// Automatic renewal reminders. Finds active paid orgs nearing/over expiry and
// emails their admin once per threshold per expiry cycle. Returns emails sent.
export async function sendDueRenewalReminders(): Promise<number> {
  const orgs = await q<{ id: string; name: string; endsAt: string }>(
    `SELECT id, name, subscription_ends_at AS "endsAt" FROM organization
     WHERE plan='active' AND status='active' AND subscription_ends_at IS NOT NULL`
  );
  const now = Date.now();
  let sent = 0;
  for (const o of orgs) {
    const end = new Date(o.endsAt);
    const days = Math.ceil((end.getTime() - now) / 86400000);
    let kind: string | null = null;
    if (days < 0) kind = "expired";
    else if (days <= 7) kind = "7d";
    else if (days <= 14) kind = "14d";
    else if (days <= 30) kind = "30d";
    if (!kind) continue;
    const expiry = end.toISOString().slice(0, 10);
    if (await one(`SELECT id FROM subscription_reminder WHERE org_id=$1 AND reminder_kind=$2 AND expiry=$3`, [o.id, kind, expiry])) continue;
    const to = await orgAdminEmail(o.id);
    await q(`INSERT INTO subscription_reminder (id, org_id, reminder_kind, expiry) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [id("rem"), o.id, kind, expiry]);
    if (!to) continue;
    const subject = days < 0 ? `Your Project Strand subscription has expired` : `Project Strand subscription renews in ${days} day${days === 1 ? "" : "s"}`;
    const html = shell(
      days < 0
        ? `<p style="font-size:16px;font-weight:700">Your subscription has expired</p>
           <p>Hello <strong>${o.name}</strong>, your Project Strand subscription expired on <strong>${fmt(expiry)}</strong>.
           Please renew to keep full access — contact us to arrange your renewal.</p>`
        : `<p style="font-size:16px;font-weight:700">Subscription renewal due</p>
           <p>Hello <strong>${o.name}</strong>, your Project Strand subscription will expire on <strong>${fmt(expiry)}</strong>
           (in ${days} day${days === 1 ? "" : "s"}). Please arrange your renewal before then to avoid interruption.</p>`
    );
    const res = await sendEmail({ to, subject, html });
    if (res.status === "sent") sent++;
  }
  return sent;
}

/* ===================== PLATFORM BILLING SETTINGS ===================== */
export type PlatformSettings = {
  currency: string; vatRate: number; rate1yr: number; rate3yr: number; rate5yr: number; bankDetails: string | null; momoDetails: string | null;
  issuerName: string | null; issuerTin: string | null; issuerAddress: string | null; issuerEmail: string | null; issuerPhone: string | null; issuerWebsite: string | null; issuerLogoDataUrl: string | null;
};

export async function getPlatformSettings(): Promise<PlatformSettings> {
  const r = await one<PlatformSettings>(
    `SELECT currency, vat_rate::float AS "vatRate", rate_1yr::float AS "rate1yr", rate_3yr::float AS "rate3yr",
            rate_5yr::float AS "rate5yr", bank_details AS "bankDetails", momo_details AS "momoDetails",
            issuer_name AS "issuerName", issuer_tin AS "issuerTin", issuer_address AS "issuerAddress",
            issuer_email AS "issuerEmail", issuer_phone AS "issuerPhone", issuer_website AS "issuerWebsite",
            issuer_logo_data_url AS "issuerLogoDataUrl"
     FROM platform_settings WHERE id='singleton'`
  );
  return r ?? { currency: "USD", vatRate: 0, rate1yr: 0, rate3yr: 0, rate5yr: 0, bankDetails: null, momoDetails: null,
    issuerName: null, issuerTin: null, issuerAddress: null, issuerEmail: null, issuerPhone: null, issuerWebsite: null, issuerLogoDataUrl: null };
}

// Saves rates + issuer text identity. The logo is managed separately so saving
// text settings never clobbers an uploaded logo.
export async function upsertPlatformSettings(s: Omit<PlatformSettings, "issuerLogoDataUrl">): Promise<void> {
  await q(
    `INSERT INTO platform_settings (id, currency, vat_rate, rate_1yr, rate_3yr, rate_5yr, bank_details, momo_details,
            issuer_name, issuer_tin, issuer_address, issuer_email, issuer_phone, issuer_website, updated_at)
     VALUES ('singleton',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
     ON CONFLICT (id) DO UPDATE SET currency=$1, vat_rate=$2, rate_1yr=$3, rate_3yr=$4, rate_5yr=$5, bank_details=$6, momo_details=$7,
            issuer_name=$8, issuer_tin=$9, issuer_address=$10, issuer_email=$11, issuer_phone=$12, issuer_website=$13, updated_at=now()`,
    [s.currency, s.vatRate, s.rate1yr, s.rate3yr, s.rate5yr, s.bankDetails, s.momoDetails,
     s.issuerName, s.issuerTin, s.issuerAddress, s.issuerEmail, s.issuerPhone, s.issuerWebsite]
  );
}

export async function setIssuerLogo(dataUrl: string | null): Promise<void> {
  await q(
    `INSERT INTO platform_settings (id, issuer_logo_data_url, updated_at) VALUES ('singleton',$1,now())
     ON CONFLICT (id) DO UPDATE SET issuer_logo_data_url=$1, updated_at=now()`, [dataUrl]
  );
}

export function rateForTerm(s: PlatformSettings, months: number): number {
  return months >= 60 ? s.rate5yr : months >= 36 ? s.rate3yr : s.rate1yr;
}

const termLabel = (m: number) => m % 12 === 0 ? `${m / 12} year${m === 12 ? "" : "s"}` : `${m} months`;

// Email + in-app notify every platform operator.
async function notifyOperators(subject: string, html: string, link = "/admin"): Promise<void> {
  await sendEmail({ to: SYSTEM_ADMIN_EMAIL, subject, html });
  const supers = await q<{ id: string }>(`SELECT id FROM app_user WHERE is_super_admin=true`);
  for (const s of supers) await notify({ userId: s.id, type: "approval_needed", title: subject, link, email: false });
}

/* ===================== SUBSCRIPTION RENEWAL REQUESTS ===================== */

// Org admin/finance requests a renewal term. One open request per org at a time.
export async function requestRenewal(input: { orgId: string; termMonths: number; note?: string; by: { id: string; name: string } }): Promise<string> {
  const open = await one<{ id: string }>(
    `SELECT id FROM subscription_request WHERE org_id=$1 AND status IN ('requested','invoiced','payment_submitted') ORDER BY created_at DESC LIMIT 1`, [input.orgId]
  );
  if (open) return open.id;
  const rid = id("subreq");
  await q(`INSERT INTO subscription_request (id, org_id, status, term_months, requested_by, requested_by_name, note) VALUES ($1,$2,'requested',$3,$4,$5,$6)`,
    [rid, input.orgId, input.termMonths, input.by.id, input.by.name, input.note ?? null]);
  const org = await one<{ name: string }>(`SELECT name FROM organization WHERE id=$1`, [input.orgId]);
  await writeAudit({ orgId: input.orgId, userId: input.by.id, action: "create", entity: "subscription_request", entityId: rid, after: { termMonths: input.termMonths } });
  await notifyOperators(
    `Renewal request — ${org?.name ?? "Organisation"}`,
    shell(`<p style="font-size:16px;font-weight:700">New subscription renewal request</p>
           <p><strong>${org?.name ?? "An organisation"}</strong> has requested a renewal for <strong>${termLabel(input.termMonths)}</strong>.</p>
           <p>Requested by ${input.by.name}. Open the admin control center to issue an invoice.</p>`)
  );
  return rid;
}

// Operator issues an invoice (rate + VAT + bank/mobile-money) and emails it.
export async function invoiceRequest(input: { requestId: string; subtotal: number; vatRate: number; currency: string; bankDetails: string; momoDetails: string; note?: string; by: { id: string; name: string } }): Promise<void> {
  const req = await one<{ orgId: string; termMonths: number }>(`SELECT org_id AS "orgId", term_months AS "termMonths" FROM subscription_request WHERE id=$1`, [input.requestId]);
  if (!req) throw new Error("Request not found");
  const count = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM subscription_request WHERE invoice_no IS NOT NULL`))?.c ?? 0;
  const invoiceNo = `INV-${String(count + 1).padStart(4, "0")}`;
  const vatAmount = round2(input.subtotal * (input.vatRate / 100));
  const total = round2(input.subtotal + vatAmount);
  await q(
    `UPDATE subscription_request SET status='invoiced', invoice_no=$2, invoice_subtotal=$3, vat_rate=$4, vat_amount=$5, invoice_total=$6,
            currency=$7, bank_details=$8, momo_details=$9, invoice_note=$10, invoiced_at=now(), invoiced_by=$11, invoiced_by_name=$12 WHERE id=$1`,
    [input.requestId, invoiceNo, input.subtotal, input.vatRate, vatAmount, total, input.currency, input.bankDetails, input.momoDetails, input.note ?? null, input.by.id, input.by.name]
  );
  const org = await orgBillTo(req.orgId);
  const settings = await getPlatformSettings();
  const to = await orgAdminEmail(req.orgId);
  if (to) {
    const html = shell(
      letterhead(settings, org) +
      `<p style="font-size:16px;font-weight:700">Invoice ${invoiceNo}</p>
       <p>Dear <strong>${esc(org.name)}</strong>, please find your Project Strand subscription invoice below.</p>
       <table style="width:100%;border-collapse:collapse;margin:12px 0">
         <tr><td style="padding:6px 0;color:#78716c">Invoice no.</td><td style="text-align:right;font-weight:600">${invoiceNo}</td></tr>
         <tr><td style="padding:6px 0;color:#78716c">Subscription term</td><td style="text-align:right">${termLabel(req.termMonths)}</td></tr>
         <tr><td style="padding:6px 0;color:#78716c">Subtotal</td><td style="text-align:right">${money(input.subtotal, input.currency)}</td></tr>
         <tr><td style="padding:6px 0;color:#78716c">VAT (${input.vatRate}%)</td><td style="text-align:right">${money(vatAmount, input.currency)}</td></tr>
         <tr><td style="padding:8px 0;border-top:1px solid #e7e5e4;font-weight:700">Total due</td><td style="text-align:right;border-top:1px solid #e7e5e4;font-weight:700">${money(total, input.currency)}</td></tr>
       </table>
       <div style="background:#faf9f7;border:1px solid #e7e5e4;border-radius:8px;padding:12px;margin:10px 0">
         <div style="font-weight:700;margin-bottom:4px">Bank transfer</div>
         <div style="white-space:pre-wrap;color:#44403c">${(input.bankDetails || "—").replace(/</g, "&lt;")}</div>
         <div style="font-weight:700;margin:10px 0 4px">Mobile money</div>
         <div style="white-space:pre-wrap;color:#44403c">${(input.momoDetails || "—").replace(/</g, "&lt;")}</div>
       </div>
       ${input.note ? `<p style="color:#44403c">${input.note.replace(/</g, "&lt;")}</p>` : ""}
       <p>Once paid, upload your proof of payment in Project Strand (Organisation → Subscription) and we will activate your renewal.</p>`
    );
    await sendEmail({ to, subject: `Invoice ${invoiceNo} — Project Strand subscription`, html });
  }
  await notifyOrgAdmins(req.orgId, `Invoice ${invoiceNo} issued — pay and upload proof of payment`);
  await writeAudit({ orgId: req.orgId, userId: input.by.id, action: "update", entity: "subscription_request", entityId: input.requestId, after: { invoiceNo, total } });
}

// In-app notification to an organisation's admins (email is sent separately by the
// individual steps). Keeps the whole exchange visible inside the system too.
async function notifyOrgAdmins(orgId: string, title: string, link = "/organization/subscription"): Promise<void> {
  const admins = await q<{ userId: string }>(
    `SELECT m.user_id AS "userId" FROM org_membership m JOIN role r ON r.id=m.role_id WHERE m.org_id=$1 AND r.key='org_admin'`, [orgId]);
  for (const a of admins) await notify({ orgId, userId: a.userId, type: "approval_needed", title, link, email: false });
}

// Auto-issue the invoice for a just-created request using the platform's billing
// settings (the rate for the chosen term, VAT, currency, bank & mobile-money). This
// fires the moment an organisation selects a plan, so they get a signed invoice
// immediately without waiting for the operator to raise one by hand.
export async function autoInvoiceFromSettings(requestId: string, by: { id: string; name: string }): Promise<void> {
  const req = await one<{ termMonths: number; status: string }>(`SELECT term_months AS "termMonths", status FROM subscription_request WHERE id=$1`, [requestId]);
  if (!req || req.status !== "requested") return; // already invoiced or beyond
  const s = await getPlatformSettings();
  await invoiceRequest({
    requestId, subtotal: rateForTerm(s, req.termMonths), vatRate: s.vatRate, currency: s.currency,
    bankDetails: s.bankDetails ?? "", momoDetails: s.momoDetails ?? "", by,
  });
}

// Organisation uploads proof of payment.
export async function submitPaymentProof(input: { requestId: string; storageKey: string; fileName: string; mime: string; size: number; paymentRef?: string; note?: string }): Promise<void> {
  await q(
    `UPDATE subscription_request SET status='payment_submitted', payment_storage_key=$2, payment_file_name=$3, payment_mime=$4, payment_size=$5,
            payment_ref=$6, payment_note=$7, payment_submitted_at=now() WHERE id=$1 AND status='invoiced'`,
    [input.requestId, input.storageKey, input.fileName, input.mime, input.size, input.paymentRef ?? null, input.note ?? null]
  );
  const req = await one<{ orgId: string; orgName: string }>(`SELECT sr.org_id AS "orgId", o.name AS "orgName" FROM subscription_request sr JOIN organization o ON o.id=sr.org_id WHERE sr.id=$1`, [input.requestId]);
  if (req) await notifyOperators(
    `Payment proof submitted — ${req.orgName}`,
    shell(`<p style="font-size:16px;font-weight:700">Proof of payment received</p>
           <p><strong>${req.orgName}</strong> has uploaded proof of payment for their subscription renewal. Review it in the admin control center and approve to renew.</p>`)
  );
}

// Operator approves: records the payment (extends subscription), emails a receipt.
export async function approveRequest(input: { requestId: string; by: { id: string; name: string } }): Promise<void> {
  const req = await one<{ orgId: string; status: string; termMonths: number; total: number | null; currency: string | null; invoiceNo: string | null }>(
    `SELECT org_id AS "orgId", status, term_months AS "termMonths", invoice_total::float AS total, currency, invoice_no AS "invoiceNo" FROM subscription_request WHERE id=$1`, [input.requestId]
  );
  if (!req) throw new Error("Request not found");
  if (req.status !== "payment_submitted") throw new Error("Request is not awaiting approval");
  const pid = await recordSubscriptionPayment({
    orgId: req.orgId, amount: req.total ?? 0, currency: req.currency ?? "USD", termMonths: req.termMonths,
    reference: req.invoiceNo ?? undefined, by: input.by,
  });
  await sendReceiptEmail(pid);
  await q(`UPDATE subscription_request SET status='approved', completed_at=now(), completed_by=$2, completed_by_name=$3, payment_id=$4 WHERE id=$1`,
    [input.requestId, input.by.id, input.by.name, pid]);
  await notifyOrgAdmins(req.orgId, `Subscription activated — payment approved. Thank you!`);
  await writeAudit({ orgId: req.orgId, userId: input.by.id, action: "update", entity: "subscription_request", entityId: input.requestId, after: { approved: true, paymentId: pid } });
}

export async function rejectRequest(input: { requestId: string; reason: string; by: { id: string; name: string } }): Promise<void> {
  const req = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM subscription_request WHERE id=$1`, [input.requestId]);
  if (!req) return;
  await q(`UPDATE subscription_request SET status='rejected', reject_reason=$2, completed_at=now(), completed_by=$3, completed_by_name=$4 WHERE id=$1`,
    [input.requestId, input.reason, input.by.id, input.by.name]);
  const to = await orgAdminEmail(req.orgId);
  if (to) await sendEmail({ to, subject: `Subscription renewal — update`, html: shell(`<p>Your subscription renewal request needs attention:</p><p style="color:#44403c">${input.reason.replace(/</g, "&lt;")}</p><p>Please start a new request in Project Strand (Organisation → Subscription) if needed.</p>`) });
  await notifyOrgAdmins(req.orgId, `Subscription request needs attention — ${input.reason.slice(0, 60)}`);
  await writeAudit({ orgId: req.orgId, userId: input.by.id, action: "update", entity: "subscription_request", entityId: input.requestId, after: { rejected: true } });
}

// Organisation cancels its own open request.
export async function cancelRequest(requestId: string, orgId: string): Promise<void> {
  await q(`UPDATE subscription_request SET status='cancelled' WHERE id=$1 AND org_id=$2 AND status IN ('requested','invoiced','payment_submitted')`, [requestId, orgId]);
}

export type OrgRequest = {
  id: string; status: string; termMonths: number; requestedAt: string; note: string | null;
  invoiceNo: string | null; subtotal: number | null; vatRate: number | null; vatAmount: number | null;
  total: number | null; currency: string | null; bankDetails: string | null; momoDetails: string | null;
  invoiceNote: string | null; invoicedAt: string | null; paymentFileName: string | null; paymentRef: string | null;
  paymentSubmittedAt: string | null; completedAt: string | null; rejectReason: string | null;
};

// The current open/most-recent request for an organisation (for the org page).
export async function getOrgRequest(orgId: string): Promise<OrgRequest | null> {
  return one<OrgRequest>(
    `SELECT id, status, term_months AS "termMonths", requested_at AS "requestedAt", note,
            invoice_no AS "invoiceNo", invoice_subtotal::float AS subtotal, vat_rate::float AS "vatRate",
            vat_amount::float AS "vatAmount", invoice_total::float AS total, currency, bank_details AS "bankDetails",
            momo_details AS "momoDetails", invoice_note AS "invoiceNote", invoiced_at AS "invoicedAt",
            payment_file_name AS "paymentFileName", payment_ref AS "paymentRef", payment_submitted_at AS "paymentSubmittedAt",
            completed_at AS "completedAt", reject_reason AS "rejectReason"
     FROM subscription_request WHERE org_id=$1 ORDER BY created_at DESC LIMIT 1`, [orgId]
  );
}
