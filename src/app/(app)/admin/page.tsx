import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { q } from "@/server/db";
import { PageHeader, Stat, SectionTitle, Badge, Field } from "@/components/ui";
import { createAdminAction, createOrganizationAction, setOrgStateAction, sendTestEmailAction, setSuperAdminAction,
  activateSubscriptionAction, recordPaymentAction, sendReceiptAction, sendAnnouncementAction,
  invoiceRequestAction, approveRenewalAction, rejectRenewalAction, savePlatformSettingsAction } from "@/app/actions";
import { sendDueRenewalReminders, getPlatformSettings, rateForTerm } from "@/server/services/billing";
import { SYSTEM_ADMIN_EMAIL } from "@/lib/config";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";

function daysLeft(iso: string | null): number | null { return iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000) : null; }

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ created?: string; error?: string; test?: string; testerror?: string; via?: string; to?: string; su?: string; sub?: string; receipt?: string; announce?: string; inv?: string; renew?: string; settings?: string }> }) {
  const user = await requireUser();
  if (!user.isSuperAdmin) redirect("/dashboard");
  const sp = await searchParams;
  const { created, error, test, testerror, via, to, su } = sp;
  const emailProvider = process.env.EMAIL_PROVIDER || "console";

  // Fire any due renewal reminders opportunistically when the operator opens the
  // console (the per-cycle log prevents duplicate sends). Never blocks the page.
  try { await sendDueRenewalReminders(); } catch { /* non-fatal */ }

  const orgs = await q<{ id: string; name: string; plan: string; status: string; trialEndsAt: string | null; subEndsAt: string | null; termMonths: number | null; adminEmail: string | null; members: number; projects: number }>(
    `SELECT o.id, o.name, o.plan, o.status, o.trial_ends_at AS "trialEndsAt",
            o.subscription_ends_at AS "subEndsAt", o.subscription_term_months AS "termMonths",
            (SELECT u.email FROM org_membership m JOIN app_user u ON u.id=m.user_id JOIN role r ON r.id=m.role_id
             WHERE m.org_id=o.id AND r.key='org_admin' ORDER BY m.created_at LIMIT 1) AS "adminEmail",
            (SELECT COUNT(*)::int FROM org_membership m WHERE m.org_id=o.id) AS members,
            (SELECT COUNT(*)::int FROM project p WHERE p.org_id=o.id) AS projects
     FROM organization o ORDER BY o.created_at DESC`
  );

  // Recent subscription payments, grouped per organisation (for the receipts panel).
  const payRows = await q<{ id: string; orgId: string; receiptNo: string | null; amount: number; currency: string; paidOn: string; periodEnd: string | null; sentAt: string | null }>(
    `SELECT id, org_id AS "orgId", receipt_no AS "receiptNo", amount::float AS amount, currency,
            paid_on AS "paidOn", period_end AS "periodEnd", receipt_sent_at AS "sentAt"
     FROM subscription_payment ORDER BY created_at DESC`
  );
  const paymentsByOrg = new Map<string, typeof payRows>();
  for (const p of payRows) { if (!paymentsByOrg.has(p.orgId)) paymentsByOrg.set(p.orgId, []); paymentsByOrg.get(p.orgId)!.push(p); }

  const announcements = await q<{ id: string; subject: string; audience: string; recipients: number; sentCount: number; createdAt: string; by: string | null }>(
    `SELECT id, subject, audience, recipients, sent_count AS "sentCount", created_at AS "createdAt", created_by_name AS by
     FROM platform_announcement ORDER BY created_at DESC LIMIT 8`
  );

  // Open subscription renewal requests + the billing defaults used to pre-fill invoices.
  const subRequests = await q<{ id: string; orgId: string; orgName: string; status: string; termMonths: number; requestedByName: string | null; requestedAt: string; invoiceNo: string | null; total: number | null; currency: string | null; paymentFileName: string | null; paymentRef: string | null; note: string | null }>(
    `SELECT sr.id, sr.org_id AS "orgId", o.name AS "orgName", sr.status, sr.term_months AS "termMonths",
            sr.requested_by_name AS "requestedByName", sr.requested_at AS "requestedAt", sr.invoice_no AS "invoiceNo",
            sr.invoice_total::float AS total, sr.currency, sr.payment_file_name AS "paymentFileName", sr.payment_ref AS "paymentRef", sr.note
     FROM subscription_request sr JOIN organization o ON o.id=sr.org_id
     WHERE sr.status IN ('requested','invoiced','payment_submitted') ORDER BY sr.created_at DESC`
  );
  const settings = await getPlatformSettings();

  const counts = await q<{ orgs: number; trial: number; paid: number; admins: number }>(
    `SELECT (SELECT COUNT(*)::int FROM organization) AS orgs,
            (SELECT COUNT(*)::int FROM organization WHERE plan='trial') AS trial,
            (SELECT COUNT(*)::int FROM organization WHERE plan!='trial') AS paid,
            (SELECT COUNT(*)::int FROM app_user u WHERE u.is_super_admin=true
               OR EXISTS(SELECT 1 FROM org_membership m JOIN role r ON r.id=m.role_id WHERE m.user_id=u.id AND r.key='org_admin')) AS admins`
  );
  const c = counts[0];

  // Operator only sees platform admins + the organisation admins they provisioned —
  // not every employee/member/collaborator created inside tenant organisations.
  const users = await q<{ id: string; name: string; email: string; status: string; isSuper: boolean; orgName: string | null }>(
    `SELECT u.id, u.name, u.email, u.status, u.is_super_admin AS "isSuper",
            (SELECT o.name FROM org_membership m JOIN role r ON r.id=m.role_id JOIN organization o ON o.id=m.org_id
             WHERE m.user_id=u.id AND r.key='org_admin' ORDER BY m.created_at LIMIT 1) AS "orgName"
     FROM app_user u
     WHERE u.is_super_admin=true
        OR EXISTS(SELECT 1 FROM org_membership m JOIN role r ON r.id=m.role_id WHERE m.user_id=u.id AND r.key='org_admin')
     ORDER BY u.created_at`
  );
  // Platform-level audit only — the operator does not see tenant project or
  // financial activity (requisitions, budgets, activities, etc.).
  const audit = await q<{ id: string; action: string; entity: string; createdAt: string; actor: string | null }>(
    `SELECT a.id, a.action, a.entity, a.created_at AS "createdAt", u.name AS actor
     FROM audit_log a LEFT JOIN app_user u ON u.id=a.user_id
     WHERE a.entity IN ('organization','app_user','role','user_profile')
     ORDER BY a.created_at DESC LIMIT 15`
  );

  return (
    <div className="space-y-7">
      <PageHeader title="Admin control center" subtitle="Manage organisations, their admins and platform accounts. Tenant project and financial data stays private to each organisation." />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Organisations" value={c.orgs} />
        <Stat label="On trial" value={c.trial} />
        <Stat label="Paid" value={c.paid} />
        <Stat label="Admins" value={c.admins} />
      </div>

      {sp.sub === "activated" && <div className="card p-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Subscription activated / renewed.</div>}
      {sp.receipt === "sent" && <div className="card p-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Payment recorded and receipt emailed to the organisation.</div>}
      {sp.receipt === "saved" && <div className="card p-3 text-sm" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>Payment recorded, but the receipt email could not be sent (check email settings).</div>}
      {sp.receipt === "failed" && <div className="card p-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>The receipt could not be emailed (check email settings / organisation email).</div>}
      {sp.announce === "fields" && <div className="card p-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A subject and message are required.</div>}
      {sp.announce && sp.announce.includes("of") && <div className="card p-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Announcement sent to {sp.announce.replace("of", " of ")} organisations.</div>}
      {sp.inv === "sent" && <div className="card p-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Invoice issued and emailed to the organisation.</div>}
      {sp.renew === "done" && <div className="card p-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Subscription renewed — the organisation was sent a receipt.</div>}
      {sp.renew === "rejected" && <div className="card p-3 text-sm" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>Renewal request returned to the organisation.</div>}
      {sp.settings === "saved" && <div className="card p-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Billing settings saved.</div>}

      {/* ---------------- Email delivery ---------------- */}
      <div>
        <SectionTitle>Email delivery</SectionTitle>
        <div className="card p-4">
          <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
            Provider: <Badge tone={emailProvider === "console" ? "warn" : "brand"}>{emailProvider}</Badge>{" "}
            {emailProvider === "console" && "— emails are only written to the server logs, not delivered. Set EMAIL_PROVIDER=smtp (or resend) to send real mail."}
          </p>
          {emailProvider === "smtp" && (
            <div className="card p-3 mb-3 text-sm" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>
              Heads up: many hosts (including Render) block outbound SMTP ports (25/465/587), which shows up as a
              &ldquo;Connection timeout&rdquo;. If sends time out, switch to an HTTP API provider — set
              <strong> EMAIL_PROVIDER=resend</strong> with a <strong>RESEND_API_KEY</strong> (sends over HTTPS, not blocked).
            </div>
          )}
          {test === "ok" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Test email sent to {to} via {via}. Check that inbox (and spam).</div>}
          {testerror && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Send failed via {via}: {testerror}</div>}
          <form action={sendTestEmailAction} className="flex flex-wrap items-end gap-3">
            <Field label="Send a test to"><input name="to" type="email" className="input" placeholder={SYSTEM_ADMIN_EMAIL} /></Field>
            <button className="btn btn-primary" type="submit">Send test email</button>
          </form>
          <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
            Gmail / Google Workspace needs a 16-character <strong>App Password</strong> (not your normal password) as SMTP_PASS,
            with 2-Step Verification enabled on the sending account.
          </p>
        </div>
      </div>

      {/* ---------------- Organisations (tenants) ---------------- */}
      <div>
        <SectionTitle>Organisations</SectionTitle>
        {created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Organisation created — the admin was emailed their username and temporary password.</div>}
        {error && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{error}</div>}

        <form action={createOrganizationAction} className="card p-4 mb-3 grid sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
          <Field label="Organisation name"><input name="orgName" required className="input" placeholder="African Center for Health Research" /></Field>
          <Field label="Admin name"><input name="adminName" className="input" placeholder="Full name" /></Field>
          <Field label="Admin email"><input type="email" name="adminEmail" required className="input" placeholder="admin@org.org" /></Field>
          <div className="flex items-end gap-2">
            <Field label="Trial (days)"><input type="number" name="trialDays" defaultValue={90} className="input" style={{ width: 90 }} /></Field>
            <button className="btn btn-primary" type="submit">Create</button>
          </div>
          <p className="sm:col-span-2 lg:col-span-4 text-xs" style={{ color: "var(--muted)" }}>
            Creates the workspace + its admin account and emails them their username and temporary password. Each organisation only ever sees its own projects.
          </p>
        </form>

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">Organisation</th><th className="th text-left">Admin</th>
              <th className="th text-left">Plan</th><th className="th text-left">Renews</th><th className="th text-center">Projects</th>
              <th className="th text-left">Actions</th>
            </tr></thead>
            <tbody>
              {orgs.map((o) => {
                const ended = o.plan === "trial" && o.trialEndsAt && new Date(o.trialEndsAt) < new Date();
                const tone = o.status === "suspended" ? "danger" : o.plan === "active" ? "ok" : ended ? "danger" : "warn";
                const planLabel = o.status === "suspended" ? "Suspended" : o.plan === "active" ? "Paid · active" : ended ? "Trial ended" : `Trial · ends ${fmtDate(o.trialEndsAt)}`;
                const subLeft = daysLeft(o.subEndsAt);
                const pays = paymentsByOrg.get(o.id) ?? [];
                return (
                  <tr key={o.id} className="hover:bg-[var(--surface)]">
                    <td className="td"><div className="font-medium">{o.name}</div><div className="text-xs" style={{ color: "var(--muted)" }}>{o.members} member{o.members === 1 ? "" : "s"}</div></td>
                    <td className="td text-xs">{o.adminEmail ?? "—"}</td>
                    <td className="td"><Badge tone={tone}>{planLabel}</Badge></td>
                    <td className="td text-xs">
                      {o.plan === "active" && o.subEndsAt
                        ? (subLeft !== null && subLeft < 0
                            ? <span style={{ color: "var(--danger)" }}>Expired {fmtDate(o.subEndsAt)}</span>
                            : <span style={subLeft !== null && subLeft <= 30 ? { color: "var(--warn)" } : undefined}>{subLeft}d · {fmtDate(o.subEndsAt)}</span>)
                        : "—"}
                    </td>
                    <td className="td text-center">{o.projects}</td>
                    <td className="td">
                      <div className="flex flex-wrap gap-1.5">
                        <details className="editor"><summary className="btn btn-sm btn-primary">Subscription</summary>
                          <div className="editor-panel card p-4" style={{ width: 420 }}>
                            <div className="font-display font-semibold mb-1">{o.name}</div>
                            <div className="text-xs mb-3" style={{ color: "var(--muted)" }}>
                              {o.plan === "active" && o.subEndsAt
                                ? (subLeft !== null && subLeft < 0 ? `Subscription expired ${fmtDate(o.subEndsAt)}` : `Renews ${fmtDate(o.subEndsAt)} · ${subLeft} days left`)
                                : o.plan === "trial" ? `On trial${o.trialEndsAt ? ` · ends ${fmtDate(o.trialEndsAt)}` : ""}` : "No active subscription"}
                            </div>

                            <div className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Activate / renew</div>
                            <form action={activateSubscriptionAction} className="flex items-end gap-2 mb-4">
                              <input type="hidden" name="orgId" value={o.id} />
                              <Field label="Term"><select name="termMonths" className="select"><option value="12">1 year</option><option value="36">3 years</option><option value="60">5 years</option></select></Field>
                              <button className="btn btn-sm btn-primary" type="submit">Apply</button>
                            </form>

                            <div className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Record payment &amp; email receipt</div>
                            <form action={recordPaymentAction} className="grid grid-cols-2 gap-2">
                              <input type="hidden" name="orgId" value={o.id} />
                              <Field label="Amount"><input type="number" step="0.01" name="amount" className="input" /></Field>
                              <Field label="Currency"><input name="currency" defaultValue="USD" className="input" /></Field>
                              <Field label="Term"><select name="termMonths" className="select"><option value="12">1 year</option><option value="36">3 years</option><option value="60">5 years</option></select></Field>
                              <Field label="Paid on"><input type="date" name="paidOn" className="input" /></Field>
                              <div className="col-span-2"><Field label="Reference"><input name="reference" className="input" placeholder="Bank ref / invoice no." /></Field></div>
                              <div className="col-span-2 flex justify-end"><button className="btn btn-sm btn-primary" type="submit">Record &amp; send receipt</button></div>
                            </form>

                            {pays.length > 0 && (
                              <div className="mt-3 border-t pt-2" style={{ borderColor: "var(--border)" }}>
                                <div className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Receipts</div>
                                <ul className="text-xs space-y-1">
                                  {pays.slice(0, 5).map((p) => (
                                    <li key={p.id} className="flex items-center justify-between gap-2">
                                      <span>{p.receiptNo} · {money(p.amount, p.currency)} · {fmtDate(p.paidOn)}</span>
                                      <form action={sendReceiptAction}><input type="hidden" name="paymentId" value={p.id} /><button className="btn btn-sm" type="submit">{p.sentAt ? "Resend" : "Send"}</button></form>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        </details>
                        <form action={setOrgStateAction}><input type="hidden" name="orgId" value={o.id} /><input type="hidden" name="action" value="extend" /><input type="hidden" name="days" value="90" /><button className="btn btn-sm" type="submit">+90d trial</button></form>
                        <form action={setOrgStateAction}><input type="hidden" name="orgId" value={o.id} /><input type="hidden" name="action" value={o.status === "suspended" ? "activate" : "suspend"} /><button className="btn btn-sm" type="submit">{o.status === "suspended" ? "Unsuspend" : "Suspend"}</button></form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- Subscription requests ---------------- */}
      <div>
        <SectionTitle>Subscription requests</SectionTitle>
        {subRequests.length === 0 ? (
          <div className="card p-4 text-sm" style={{ color: "var(--muted)" }}>No open renewal requests. When an organisation (including trials) requests a renewal, it appears here to invoice and approve.</div>
        ) : (
          <div className="space-y-3">
            {subRequests.map((r) => {
              const years = r.termMonths % 12 === 0 ? `${r.termMonths / 12} year${r.termMonths === 12 ? "" : "s"}` : `${r.termMonths} months`;
              const presetSubtotal = rateForTerm(settings, r.termMonths);
              return (
                <div key={r.id} className="card p-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
                    <div className="font-medium">{r.orgName} · <span style={{ color: "var(--muted)" }}>{years}</span></div>
                    <Badge tone={r.status === "requested" ? "warn" : r.status === "invoiced" ? "info" : "brand"}>
                      {r.status === "requested" ? "Needs invoice" : r.status === "invoiced" ? "Awaiting payment" : "Proof submitted"}
                    </Badge>
                  </div>
                  <div className="text-xs mb-2" style={{ color: "var(--muted)" }}>Requested by {r.requestedByName ?? "—"} · {fmtDate(r.requestedAt)}{r.note ? ` · “${r.note}”` : ""}</div>

                  {r.status === "requested" && (
                    <form action={invoiceRequestAction} className="grid sm:grid-cols-2 gap-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
                      <input type="hidden" name="requestId" value={r.id} />
                      <Field label="Subtotal (rate)"><input type="number" step="0.01" name="subtotal" defaultValue={presetSubtotal || ""} className="input" /></Field>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="VAT %"><input type="number" step="0.01" name="vatRate" defaultValue={settings.vatRate || ""} className="input" /></Field>
                        <Field label="Currency"><input name="currency" defaultValue={settings.currency} className="input" /></Field>
                      </div>
                      <Field label="Bank details"><textarea name="bankDetails" rows={3} defaultValue={settings.bankDetails ?? ""} className="textarea" /></Field>
                      <Field label="Mobile money details"><textarea name="momoDetails" rows={3} defaultValue={settings.momoDetails ?? ""} className="textarea" /></Field>
                      <div className="sm:col-span-2"><Field label="Note (optional)"><input name="note" className="input" placeholder="Shown on the invoice email" /></Field></div>
                      <div className="sm:col-span-2 flex justify-end"><button className="btn btn-primary" type="submit">Issue invoice &amp; email</button></div>
                    </form>
                  )}

                  {r.status === "invoiced" && (
                    <div className="text-sm border-t pt-3" style={{ borderColor: "var(--border)" }}>
                      Invoice <span className="font-mono" style={{ color: "var(--brand)" }}>{r.invoiceNo}</span> for {money(r.total ?? 0, r.currency ?? "USD")} sent. Waiting for the organisation to pay and upload proof.
                    </div>
                  )}

                  {r.status === "payment_submitted" && (
                    <div className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
                      <div className="text-sm mb-2">Invoice <span className="font-mono" style={{ color: "var(--brand)" }}>{r.invoiceNo}</span> · {money(r.total ?? 0, r.currency ?? "USD")} · proof: {r.paymentFileName ? <a className="underline" href={`/api/subscription-files/${r.id}`} target="_blank" rel="noopener">{r.paymentFileName}</a> : "—"}{r.paymentRef ? ` · ref ${r.paymentRef}` : ""}</div>
                      <div className="flex flex-wrap gap-2 items-start">
                        <form action={approveRenewalAction}><input type="hidden" name="requestId" value={r.id} /><button className="btn btn-sm btn-primary" type="submit">Approve &amp; renew</button></form>
                        <details className="editor"><summary className="btn btn-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Reject</summary>
                          <div className="editor-panel card p-4">
                            <form action={rejectRenewalAction} className="grid gap-2">
                              <input type="hidden" name="requestId" value={r.id} />
                              <Field label="Reason"><input name="reason" required className="input" placeholder="e.g. payment not received" /></Field>
                              <div className="flex justify-end"><button className="btn btn-sm" type="submit">Send</button></div>
                            </form>
                          </div>
                        </details>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-4">
          <SectionTitle>Billing settings</SectionTitle>
          <form action={savePlatformSettingsAction} className="card p-4 grid sm:grid-cols-2 gap-3">
            <p className="sm:col-span-2 text-sm" style={{ color: "var(--muted)" }}>Defaults used to pre-fill renewal invoices — set your standard rates, VAT and payment details once.</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Currency"><input name="currency" defaultValue={settings.currency} className="input" /></Field>
              <Field label="VAT %"><input type="number" step="0.01" name="vatRate" defaultValue={settings.vatRate || ""} className="input" /></Field>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="1-year rate"><input type="number" step="0.01" name="rate1yr" defaultValue={settings.rate1yr || ""} className="input" /></Field>
              <Field label="3-year rate"><input type="number" step="0.01" name="rate3yr" defaultValue={settings.rate3yr || ""} className="input" /></Field>
              <Field label="5-year rate"><input type="number" step="0.01" name="rate5yr" defaultValue={settings.rate5yr || ""} className="input" /></Field>
            </div>
            <Field label="Bank details"><textarea name="bankDetails" rows={3} defaultValue={settings.bankDetails ?? ""} className="textarea" placeholder="Bank, account name, account no., branch, SWIFT" /></Field>
            <Field label="Mobile money details"><textarea name="momoDetails" rows={3} defaultValue={settings.momoDetails ?? ""} className="textarea" placeholder="Provider, number, registered name" /></Field>
            <div className="sm:col-span-2 flex justify-end"><button className="btn btn-primary" type="submit">Save billing settings</button></div>
          </form>
        </div>
      </div>

      {/* ---------------- Announcements ---------------- */}
      <div>
        <SectionTitle>Announcements &amp; notices</SectionTitle>
        <div className="card p-4 mb-3">
          <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>Email all organisation admins about planned maintenance, upgrades or other notices. One email per organisation, sent to its admin address.</p>
          <form action={sendAnnouncementAction} className="grid sm:grid-cols-4 gap-3 items-end">
            <div className="sm:col-span-3"><Field label="Subject"><input name="subject" required className="input" placeholder="Scheduled maintenance — Sat 21 Jun, 22:00–23:00 EAT" /></Field></div>
            <Field label="Send to"><select name="audience" className="select"><option value="all">All organisations</option><option value="active">Paid only</option><option value="trial">Trials only</option></select></Field>
            <div className="sm:col-span-4"><Field label="Message"><textarea name="body" rows={4} required className="textarea" placeholder="Write your notice. Blank lines start new paragraphs." /></Field></div>
            <div className="sm:col-span-4 flex justify-end"><button className="btn btn-primary" type="submit">Send announcement</button></div>
          </form>
        </div>
        {announcements.length > 0 && (
          <div className="card p-4">
            <div className="text-xs font-medium uppercase tracking-wide mb-2" style={{ color: "var(--muted)" }}>Recent</div>
            <div className="space-y-2">
              {announcements.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 text-sm py-1 border-b last:border-0" style={{ borderColor: "var(--border)" }}>
                  <span className="min-w-0 truncate">{a.subject} <span style={{ color: "var(--muted)" }}>· {a.audience}</span></span>
                  <span className="text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>{a.sentCount}/{a.recipients} sent · {fmtDateTime(a.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div>
          <SectionTitle>Platform admins &amp; organisation admins</SectionTitle>
          <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Shows platform operators and the admin of each organisation you provisioned — not the staff, members or collaborators created inside tenant organisations.</p>
          {su === "ok" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Platform-admin access updated.</div>}
          {su === "self" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>You can&apos;t change your own platform-admin status.</div>}
          <form action={createAdminAction} className="card p-4 mb-3 flex flex-wrap items-end gap-3">
            <Field label="New platform-admin email"><input type="email" name="email" required className="input" placeholder="operator@yourco.org" /></Field>
            <Field label="Name"><input name="name" className="input" placeholder="Full name" /></Field>
            <button className="btn btn-primary" type="submit">Create platform admin</button>
            <span className="text-xs" style={{ color: "var(--danger)" }}>
              Grants full operator access to this control center. To add an <em>organisation</em> admin instead, use the Organisations section above.
            </span>
          </form>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Name</th><th className="th text-left">Email</th><th className="th text-left">Status</th><th className="th text-right">Platform access</th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="td">{u.name} {u.isSuper && <Badge tone="brand">platform admin</Badge>} {u.orgName && <Badge tone="muted">{u.orgName}</Badge>}</td>
                    <td className="td">{u.email}</td>
                    <td className="td">{u.status === "invited" ? <Badge tone="warn">invited</Badge> : <Badge tone="ok">active</Badge>}</td>
                    <td className="td text-right">
                      {u.id === user.id ? (
                        <span className="text-xs" style={{ color: "var(--muted)" }}>You</span>
                      ) : (
                        <form action={setSuperAdminAction}>
                          <input type="hidden" name="userId" value={u.id} />
                          <input type="hidden" name="value" value={u.isSuper ? "false" : "true"} />
                          <button className="btn btn-sm" type="submit" style={u.isSuper ? { color: "var(--danger)", borderColor: "var(--danger)" } : undefined}>
                            {u.isSuper ? "Revoke admin" : "Make platform admin"}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <SectionTitle>System audit log</SectionTitle>
          <div className="card p-4">
            <div className="space-y-2">
              {audit.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 text-sm py-1 border-b last:border-0" style={{ borderColor: "var(--border)" }}>
                  <span><Badge tone="muted">{a.action}</Badge> {label(a.entity)}</span>
                  <span className="text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>{a.actor ?? "system"} · {fmtDateTime(a.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
