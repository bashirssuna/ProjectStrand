import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireProcOrg } from "../../_guard";
import { isModuleEnabled } from "@/server/modules";
import { q, one } from "@/server/db";
import { tenderBids, lowestResponsiveBid } from "@/server/services/tenders";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty, Stat } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { currencyOptions } from "@/lib/currencies";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { updateTenderAction, advanceTenderAction, deleteTenderAction, addBidAction, evaluateBidAction, removeBidAction, awardTenderAction, createContractFromTenderAction } from "@/app/actions";

const FLOW = ["draft", "advertised", "closed", "evaluation", "awarded"];
const METHODS = ["open_domestic", "open_international", "restricted", "rfq", "direct", "other"];
const CATEGORIES = ["goods", "works", "services", "consultancy"];
const BID_STATUSES = ["received", "responsive", "non_responsive", "shortlisted", "rejected"];

export default async function TenderDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const { orgId } = await requireProcOrg();
  if (!(await isModuleEnabled(orgId, "public_procurement"))) redirect("/procurement");
  const sp = await searchParams;

  const t = await one<{
    id: string; reference: string | null; title: string; description: string | null; method: string; category: string; status: string;
    estimatedValue: number; currency: string | null; committeeId: string | null; committeeName: string | null; advertisedDate: string | null; closingDate: string | null; awardBidId: string | null; note: string | null;
  }>(
    `SELECT t.id, t.reference, t.title, t.description, t.method, t.category, t.status, t.estimated_value::float8 AS "estimatedValue", t.currency,
            t.committee_id AS "committeeId", c.name AS "committeeName", t.advertised_date::text AS "advertisedDate", t.closing_date::text AS "closingDate", t.award_bid_id AS "awardBidId", t.note
     FROM tender t LEFT JOIN proc_committee c ON c.id=t.committee_id WHERE t.id=$1 AND t.org_id=$2`, [id, orgId]
  );
  if (!t) notFound();
  const [bids, lowest, vendors, committees] = await Promise.all([
    tenderBids(id), lowestResponsiveBid(id),
    q<{ id: string; name: string }>(`SELECT id, name FROM vendor WHERE org_id=$1 ORDER BY name`, [orgId]),
    q<{ id: string; name: string }>(`SELECT id, name FROM proc_committee WHERE org_id=$1 AND type='evaluation' AND status='active' ORDER BY name`, [orgId]),
  ]);
  const cur = t.currency ?? "USD";
  const stepIdx = FLOW.indexOf(t.status);
  const canAddBid = ["advertised", "closed", "evaluation"].includes(t.status);
  const inEval = t.status === "evaluation";

  return (
    <div className="max-w-4xl">
      <PageHeader title={`${t.reference ? t.reference + " — " : ""}${t.title}`} subtitle={`${label(t.method)} · ${label(t.category)}`}
        actions={<div className="flex gap-2">
          <form action={deleteTenderAction} className="inline"><input type="hidden" name="tenderId" value={t.id} /><ConfirmSubmit message="Delete this tender and all its bids?"><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button></ConfirmSubmit></form>
          <Link href="/procurement/tenders" className="btn btn-sm">← Tenders</Link>
        </div>} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Tender created.</div>}
      {sp.saved === "award" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Tender awarded.</div>}
      {(sp.saved && sp.saved !== "award") && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Updated.</div>}
      {sp.added === "bid" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Bid recorded.</div>}

      {/* Workflow */}
      <div className="card p-4 mb-5">
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {t.status === "cancelled" ? <Badge tone="danger">Cancelled</Badge> : FLOW.map((s, i) => (
            <span key={s} className="flex items-center gap-2"><Badge tone={i < stepIdx ? "ok" : i === stepIdx ? "brand" : "muted"}>{label(s)}</Badge>{i < FLOW.length - 1 && <span style={{ color: "var(--muted)" }}>›</span>}</span>
          ))}
        </div>
        {t.status === "draft" && (
          <form action={advanceTenderAction} className="grid sm:grid-cols-3 gap-3 items-end"><input type="hidden" name="tenderId" value={t.id} /><input type="hidden" name="to" value="advertised" />
            <Field label="Advertised date"><input type="date" name="advertisedDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
            <Field label="Closing date"><input type="date" name="closingDate" className="input" /></Field>
            <div><button className="btn btn-primary" type="submit">Advertise</button></div>
          </form>
        )}
        {t.status === "advertised" && (
          <form action={advanceTenderAction} className="flex items-center gap-2"><input type="hidden" name="tenderId" value={t.id} /><input type="hidden" name="to" value="closed" />
            <span className="text-sm" style={{ color: "var(--muted)" }}>Record bids below, then close bidding.</span><button className="btn btn-primary btn-sm" type="submit">Close bidding</button>
          </form>
        )}
        {t.status === "closed" && (
          <form action={advanceTenderAction} className="flex items-center gap-2"><input type="hidden" name="tenderId" value={t.id} /><input type="hidden" name="to" value="evaluation" />
            <span className="text-sm" style={{ color: "var(--muted)" }}>Bidding closed. Begin evaluation by the committee.</span><button className="btn btn-primary btn-sm" type="submit">Start evaluation</button>
          </form>
        )}
        {inEval && <p className="text-sm" style={{ color: "var(--muted)" }}>Evaluate each bid below (mark responsive, score), then award to the successful bidder.</p>}
        {t.status === "awarded" && (
          <div>
            <p className="text-sm mb-2" style={{ color: "var(--ok)" }}>Awarded to <strong>{bids.find((b) => b.id === t.awardBidId)?.bidderName ?? "—"}</strong>{(() => { const w = bids.find((b) => b.id === t.awardBidId); return w ? ` at ${money(w.bidAmount, w.currency ?? cur)}` : ""; })()}.</p>
            <form action={createContractFromTenderAction}><input type="hidden" name="tenderId" value={t.id} />
              <button className="btn btn-sm btn-primary" type="submit">Create contract from award →</button>
            </form>
          </div>
        )}
        {!["awarded", "cancelled"].includes(t.status) && (
          <form action={advanceTenderAction} className="mt-3 inline"><input type="hidden" name="tenderId" value={t.id} /><input type="hidden" name="to" value="cancelled" />
            <ConfirmSubmit message="Cancel this tender?"><button className="text-xs hover:underline" type="submit" style={{ color: "var(--danger)" }}>Cancel tender</button></ConfirmSubmit>
          </form>
        )}
      </div>

      {/* Info */}
      <div className="card p-4 mb-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <Stat label="Estimated value" value={money(t.estimatedValue, cur)} />
          <Stat label="Bids" value={String(bids.length)} />
          <Stat label="Lowest responsive" value={lowest != null ? money(lowest, cur) : "—"} />
          <Stat label="Committee" value={t.committeeName ?? "—"} />
        </div>
        <div className="grid sm:grid-cols-2 gap-y-1 text-sm">
          <div><span style={{ color: "var(--muted)" }}>Advertised: </span>{t.advertisedDate ? fmtDate(t.advertisedDate) : "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Closing: </span>{t.closingDate ? fmtDate(t.closingDate) : "—"}</div>
          {t.description && <div className="sm:col-span-2"><span style={{ color: "var(--muted)" }}>Description: </span>{t.description}</div>}
        </div>
      </div>

      {/* Bids */}
      <div className="card p-4 mb-5">
        <SectionTitle>Bids</SectionTitle>
        {bids.length === 0 ? <Empty title="No bids recorded" hint="Record bids received at opening." /> : (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Bidder</th><th className="th text-right">Amount</th><th className="th text-left">Received</th><th className="th text-left">Status</th><th className="th text-right">Score</th><th className="th" /></tr></thead>
            <tbody>{bids.map((b) => {
              const isLowest = lowest != null && b.bidAmount === lowest && ["responsive", "shortlisted", "awarded"].includes(b.status);
              const isAward = b.id === t.awardBidId;
              return (
                <tr key={b.id} style={isAward ? { background: "color-mix(in srgb, var(--ok) 10%, transparent)" } : undefined}>
                  <td className="td">{b.bidderName}{b.vendorName && b.vendorName !== b.bidderName ? <span style={{ color: "var(--muted)" }}> · {b.vendorName}</span> : null}{isAward && <Badge tone="ok">awarded</Badge>}{isLowest && !isAward && <Badge tone="info">lowest</Badge>}</td>
                  <td className="td text-right tabular-nums">{money(b.bidAmount, b.currency ?? cur)}</td>
                  <td className="td whitespace-nowrap">{b.receivedDate ? fmtDate(b.receivedDate) : "—"}</td>
                  <td className="td"><StatusBadge status={b.status} /></td>
                  <td className="td text-right tabular-nums">{b.score != null ? b.score : "—"}</td>
                  <td className="td text-right">
                    {inEval && (
                      <details className="inline-block text-left">
                        <summary className="text-xs cursor-pointer hover:underline" style={{ color: "var(--brand)" }}>evaluate</summary>
                        <form action={evaluateBidAction} className="mt-2 flex flex-wrap gap-1 items-end" style={{ minWidth: 260 }}>
                          <input type="hidden" name="tenderId" value={t.id} /><input type="hidden" name="bidId" value={b.id} />
                          <select name="bidStatus" defaultValue={b.status === "received" ? "responsive" : b.status} className="select" style={{ padding: "2px 6px", fontSize: 12 }}>{BID_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
                          <input type="number" step="any" name="score" defaultValue={b.score ?? ""} placeholder="score" className="input" style={{ width: 70, padding: "2px 6px", fontSize: 12 }} />
                          <button className="text-xs hover:underline" type="submit" style={{ color: "var(--brand)" }}>save</button>
                        </form>
                      </details>
                    )}
                    {inEval && ["responsive", "shortlisted"].includes(b.status) && (
                      <form action={awardTenderAction} className="inline ml-2"><input type="hidden" name="tenderId" value={t.id} /><input type="hidden" name="bidId" value={b.id} />
                        <ConfirmSubmit message={`Award this tender to ${b.bidderName}?`}><button className="text-xs hover:underline" type="submit" style={{ color: "var(--ok)" }}>award</button></ConfirmSubmit>
                      </form>
                    )}
                    {!inEval && t.status !== "awarded" && <form action={removeBidAction} className="inline"><input type="hidden" name="tenderId" value={t.id} /><input type="hidden" name="bidId" value={b.id} /><button className="text-xs hover:underline" type="submit" style={{ color: "var(--danger)" }}>remove</button></form>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        {canAddBid && (
          <form action={addBidAction} className="grid sm:grid-cols-5 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
            <input type="hidden" name="tenderId" value={t.id} />
            <Field label="Vendor"><select name="vendorId" className="select"><option value="">— not listed —</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
            <Field label="…or bidder name"><input name="bidderName" className="input" /></Field>
            <Field label="Bid amount"><input type="number" step="any" min={0} name="bidAmount" required className="input" /></Field>
            <Field label="Currency"><select name="currency" defaultValue={cur} className="select">{currencyOptions(cur).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
            <div className="flex gap-2"><Field label="Received"><input type="date" name="receivedDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field><button className="btn btn-sm btn-primary" type="submit" style={{ alignSelf: "flex-end" }}>Add</button></div>
          </form>
        )}
      </div>

      {/* Settings */}
      {!["awarded", "cancelled"].includes(t.status) && (
        <div className="card p-4">
          <SectionTitle>Tender settings</SectionTitle>
          <form action={updateTenderAction} className="grid sm:grid-cols-2 gap-3">
            <input type="hidden" name="tenderId" value={t.id} />
            <Field label="Reference"><input name="reference" defaultValue={t.reference ?? ""} className="input" /></Field>
            <Field label="Title"><input name="title" required defaultValue={t.title} className="input" /></Field>
            <Field label="Method"><select name="method" defaultValue={t.method} className="select">{METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></Field>
            <Field label="Category"><select name="category" defaultValue={t.category} className="select">{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
            <Field label="Estimated value"><input type="number" step="any" min={0} name="estimatedValue" defaultValue={t.estimatedValue} className="input" /></Field>
            <Field label="Currency"><select name="currency" defaultValue={cur} className="select">{currencyOptions(cur).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
            <Field label="Evaluation committee"><select name="committeeId" defaultValue={t.committeeId ?? ""} className="select"><option value="">—</option>{committees.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <div className="sm:col-span-2"><Field label="Description"><textarea name="description" rows={2} defaultValue={t.description ?? ""} className="textarea" /></Field></div>
            <div><button className="btn btn-sm btn-primary" type="submit">Save</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
