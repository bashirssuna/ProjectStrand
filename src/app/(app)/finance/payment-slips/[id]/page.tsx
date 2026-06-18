import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { q } from "@/server/db";
import { getSlip, getPayees, linkExpired, budgetLineOptions } from "@/server/services/payment-slips";
import { PageHeader, SectionTitle, Field, Badge, Empty, Stat } from "@/components/ui";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { SignField } from "@/components/sign-field";
import {
  addSlipPayeeAction, bulkAddSlipPayeesAction, deleteSlipPayeeAction,
  signSlipFinanceAction, signSlipApproverAction, assignSlipApproverAction, notifySlipApproverAction,
  sendSlipSigningLinksAction, setSlipStatusAction, setSlipBudgetLineAction,
} from "@/app/actions";

const TITLE_SUGGESTIONS = ["Principal Investigator", "Co-Principal Investigator", "Project Manager", "Project Coordinator", "Director", "Head of Department", "Manager", "Authoriser"];

export default async function SlipDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string; err?: string; assigned?: string; notified?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  const slip = await getSlip(id, org.id);
  if (!slip) redirect("/dashboard");
  const isFinance = Boolean(org.isOrgAdmin) || user.isSuperAdmin;
  const isApprover = slip.approverId === user.id;
  if (!isFinance && !isApprover) redirect("/dashboard");

  const payees = await getPayees(id);
  const total = payees.reduce((s, p) => s + p.amount, 0);
  const signedCount = payees.filter((p) => p.signed).length;
  const emailable = payees.filter((p) => p.email && !p.signed).length;
  const c = slip.currency;
  const approverLabel = slip.approverTitle || "Second signatory";
  const orgUsers = isFinance
    ? await q<{ id: string; name: string; email: string }>(
        `SELECT u.id, u.name, u.email FROM app_user u JOIN org_membership m ON m.user_id=u.id
         WHERE m.org_id=$1 ORDER BY u.name`, [org.id])
    : [];
  const lineOptions = isFinance ? await budgetLineOptions(org.id, slip.projectId) : [];

  return (
    <div className="max-w-5xl">
      <PageHeader title={slip.title} subtitle={`${slip.number} · ${slip.category ?? "Payment"} · ${fmtDate(slip.slipDate)}${slip.project ? ` · ${slip.project}` : ""}`}
        actions={<div className="flex gap-2">
          <a href={`/print/payment-slip/${id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨 Print</a>
          {isFinance ? <Link href="/finance/payment-slips" className="btn btn-sm">← All slips</Link> : <Link href="/dashboard" className="btn btn-sm">← Dashboard</Link>}
        </div>} />

      {!isFinance && isApprover && !slip.piSignature && (
        <div className="card p-3 mb-3 text-sm" style={{ borderColor: "var(--brand)" }}>You have been asked to review and sign this payment as <strong>{approverLabel}</strong>. Please check the details below and sign.</div>
      )}
      {sp.assigned && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Second signatory assigned and notified.</div>}
      {sp.notified && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Reminder sent to the second signatory.</div>}
      {sp.sent && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Signing links emailed to {sp.sent} payee{sp.sent === "1" ? "" : "s"}.</div>}
      {sp.err === "forbidden" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>You are not authorised to sign this slot.</div>}
      {sp.err === "approver" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Choose a person to be the second signatory.</div>}
      {sp.err === "sign" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Please draw or type a signature before submitting.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Payees" value={String(payees.length)} />
        <Stat label="Total" value={money(total, c)} />
        <Stat label="Signed by payees" value={`${signedCount}/${payees.length}`} />
        <Stat label="Status" value={slip.status} />
      </div>

      {/* Budget line linkage */}
      {isFinance && (
        <div className="card p-4 mb-6">
          <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "var(--muted)" }}>Budget line</div>
          {slip.budgetLineId ? (
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div className="text-sm">
                <span className="font-medium">{slip.lineCode}</span> — {slip.lineDescription}
                {(() => { const ln = lineOptions.find((l) => l.id === slip.budgetLineId); return ln ? <span style={{ color: "var(--muted)" }}> · remaining {money(ln.remaining, ln.currency)}{ln.remaining < total ? " ⚠ less than this slip" : ""}</span> : null; })()}
              </div>
              {slip.expenditureId
                ? <Badge tone="ok">✓ expenditure recorded</Badge>
                : <Badge tone="info">deducts on disbursement</Badge>}
            </div>
          ) : (
            <p className="text-sm mb-2" style={{ color: "var(--muted)" }}>Not linked to a budget line. Link one so the total is deducted from the project budget and posted to the ledger when you disburse.</p>
          )}
          {slip.expenditureId ? (
            <p className="text-xs" style={{ color: "var(--muted)" }}>This slip has been disbursed and its total recorded against the line above — it now shows in the project budget, spending, financial statements and audit log.</p>
          ) : lineOptions.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--muted)" }}>{slip.projectId ? "This project has no budget lines yet." : "Create budget lines under a project to link this slip."}</p>
          ) : (
            <form action={setSlipBudgetLineAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="slipId" value={id} />
              <div style={{ minWidth: 320, flex: 1 }}>
                <Field label="Link to budget line">
                  <select name="budgetLineId" className="select" defaultValue={slip.budgetLineId ?? ""}>
                    <option value="">— none —</option>
                    {lineOptions.map((l) => (
                      <option key={l.id} value={l.id}>{l.projectCode} · {l.code} — {l.description} (remaining {money(l.remaining, l.currency)})</option>
                    ))}
                  </select>
                </Field>
              </div>
              <button className="btn btn-sm btn-primary" type="submit">{slip.budgetLineId ? "Update" : "Link"}</button>
            </form>
          )}
        </div>
      )}

      {/* Approval signatures */}
      <SectionTitle>Approval</SectionTitle>
      <div className="grid sm:grid-cols-2 gap-4 mb-6">
        {/* Finance */}
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Finance</div>
          {slip.financeSignature ? (
            <div>
              <img src={slip.financeSignature} alt="Finance signature" style={{ maxHeight: 70 }} />
              <div className="text-sm mt-1">{slip.financeSignedName}</div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>Signed {slip.financeSignedAt ? fmtDateTime(slip.financeSignedAt) : ""}</div>
            </div>
          ) : isFinance ? (
            <form action={signSlipFinanceAction}>
              <input type="hidden" name="slipId" value={id} />
              <SignField name="signature" />
              <div className="mt-2"><button className="btn btn-sm btn-primary" type="submit">Approve &amp; sign as Finance</button></div>
            </form>
          ) : <div className="text-sm" style={{ color: "var(--muted)" }}>Awaiting Finance signature.</div>}
        </div>

        {/* Second signatory (chosen by Finance) */}
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Second signatory{slip.approverTitle ? ` — ${slip.approverTitle}` : ""}</div>
          {slip.piSignature ? (
            <div>
              <img src={slip.piSignature} alt="Approver signature" style={{ maxHeight: 70 }} />
              <div className="text-sm mt-1">{slip.piSignedName}{slip.approverTitle ? ` · ${slip.approverTitle}` : ""}</div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>Signed {slip.piSignedAt ? fmtDateTime(slip.piSignedAt) : ""}</div>
            </div>
          ) : (
            <div className="space-y-3">
              {isFinance && (
                <form action={assignSlipApproverAction} className="space-y-2">
                  <input type="hidden" name="slipId" value={id} />
                  <Field label="Who should sign (besides Finance)?">
                    <select name="approverId" className="select" defaultValue={slip.approverId ?? ""} required>
                      <option value="">— choose a person —</option>
                      {orgUsers.map((u) => <option key={u.id} value={u.id}>{u.name}{u.email ? ` (${u.email})` : ""}</option>)}
                    </select>
                  </Field>
                  <Field label="Their title on the document">
                    <input name="approverTitle" className="input" list="title-suggestions" defaultValue={slip.approverTitle ?? "Project Manager"} />
                  </Field>
                  <button className="btn btn-sm btn-primary" type="submit">{slip.approverId ? "Reassign & notify" : "Assign & notify"}</button>
                </form>
              )}
              {slip.approverId && (
                <div className="text-xs flex items-center gap-2 flex-wrap" style={{ color: "var(--muted)" }}>
                  <span>Awaiting signature from <strong style={{ color: "var(--fg)" }}>{slip.approverName}</strong> ({slip.approverTitle}).</span>
                  {isFinance && (
                    <form action={notifySlipApproverAction}><input type="hidden" name="slipId" value={id} />
                      <button className="btn btn-sm" type="submit">Resend reminder</button>
                    </form>
                  )}
                </div>
              )}
              {(isApprover || isFinance) && (
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                  {isFinance && <div className="text-xs mb-1" style={{ color: "var(--muted)" }}>Or sign this slot yourself:</div>}
                  <form action={signSlipApproverAction}>
                    <input type="hidden" name="slipId" value={id} />
                    <SignField name="signature" initialName={isApprover ? user.name : ""} />
                    <div className="mt-2"><button className="btn btn-sm btn-primary" type="submit">Approve &amp; sign{isApprover && slip.approverTitle ? ` as ${slip.approverTitle}` : ""}</button></div>
                  </form>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <datalist id="title-suggestions">{TITLE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}</datalist>

      {/* Payees */}
      <SectionTitle action={isFinance ? (
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
      ) : undefined}>People to be paid</SectionTitle>

      {payees.length === 0 ? (
        <Empty title="No payees yet" hint={isFinance ? "Add people individually or paste a list below." : "No recipients have been added yet."} />
      ) : (
        <div className="card overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">No.</th><th className="th text-left">Name</th><th className="th text-left">Phone</th>
              <th className="th text-left">Email</th><th className="th text-left">Designation</th><th className="th text-left">Payment for</th>
              <th className="th text-right">Amount</th><th className="th text-left">Signature</th>{isFinance && <th className="th"></th>}
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
                      : p.linkSentAt
                        ? (linkExpired(p.linkSentAt) ? <Badge tone="warn">link expired</Badge> : <Badge tone="info">link sent</Badge>)
                        : <span className="text-xs" style={{ color: "var(--muted)" }}>not signed</span>}
                  </td>
                  {isFinance && (
                    <td className="td text-right">
                      <form action={deleteSlipPayeeAction}><input type="hidden" name="slipId" value={id} /><input type="hidden" name="payeeId" value={p.id} />
                        <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }} title="Remove">✕</button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
              <tr>
                <td className="td" /><td className="td font-semibold" colSpan={5}>Total</td>
                <td className="td text-right font-semibold whitespace-nowrap">{money(total, c)}</td><td className="td" />{isFinance && <td className="td" />}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {isFinance && (
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
      )}
    </div>
  );
}
