import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { sendEmail } from "@/server/email";
import { writeAudit } from "@/server/services/audit";

function addMonths(d: Date, m: number): Date { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; }
const fmt = (iso: string | Date) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const money = (n: number, c: string) => `${c} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shell = (inner: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1c1917">
     <div style="border-bottom:3px solid #9a7b4f;padding:14px 0;font-size:18px;font-weight:700;color:#9a7b4f">Project Strand</div>
     <div style="padding:18px 0;font-size:14px;line-height:1.6">${inner}</div>
     <div style="border-top:1px solid #e7e5e4;padding-top:12px;font-size:12px;color:#78716c">Project Strand — research &amp; grant operations platform.</div>
   </div>`;

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
  const years = p.termMonths % 12 === 0 ? `${p.termMonths / 12} year${p.termMonths === 12 ? "" : "s"}` : `${p.termMonths} months`;
  const html = shell(
    `<p style="font-size:16px;font-weight:700">Payment receipt</p>
     <p>Thank you, <strong>${p.orgName}</strong>. We confirm receipt of your Project Strand subscription payment.</p>
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
