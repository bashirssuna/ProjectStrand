import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { postManualJournalAction, reverseJournalAction } from "@/app/actions";

export default async function JournalPage({ searchParams }: { searchParams: Promise<{ posted?: string; reversed?: string; err?: string }> }) {
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;
  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]))?.currency ?? "USD";

  const accounts = await q<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND is_active ORDER BY code`, [orgId]
  );
  const entries = await q<{
    id: string; entryNo: string; entryDate: string; memo: string | null; sourceType: string;
    postedByName: string | null; total: number; reversed: boolean; isReversal: boolean;
  }>(
    `SELECT je.id, je.entry_no AS "entryNo", je.entry_date AS "entryDate", je.memo, je.source_type AS "sourceType",
            je.posted_by_name AS "postedByName",
            COALESCE((SELECT SUM(debit) FROM journal_line WHERE entry_id=je.id),0)::float AS total,
            EXISTS(SELECT 1 FROM journal_entry r WHERE r.reverses_entry_id=je.id) AS reversed,
            (je.reverses_entry_id IS NOT NULL) AS "isReversal"
     FROM journal_entry je WHERE je.org_id=$1 ORDER BY je.created_at DESC LIMIT 100`, [orgId]
  );

  // pull lines for all shown entries in one query
  const ids = entries.map((e) => e.id);
  const lines = ids.length
    ? await q<{ entryId: string; code: string; name: string; debit: number; credit: number }>(
        `SELECT jl.entry_id AS "entryId", la.code, la.name, jl.debit::float, jl.credit::float
         FROM journal_line jl JOIN ledger_account la ON la.id=jl.account_id
         WHERE jl.entry_id = ANY($1::text[]) ORDER BY jl.debit DESC`, [ids]
      )
    : [];
  const linesByEntry = new Map<string, typeof lines>();
  for (const l of lines) { const a = linesByEntry.get(l.entryId) ?? []; a.push(l); linesByEntry.set(l.entryId, a); }

  return (
    <div className="max-w-5xl">
      <PageHeader title="General journal" subtitle="Every posted ledger entry" actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.posted && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Journal entry posted.</div>}
      {sp.reversed && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Entry reversed.</div>}
      {sp.err === "invalid" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Pick two different accounts and a positive amount.</div>}
      {sp.err && sp.err !== "invalid" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{decodeURIComponent(sp.err)}</div>}

      <SectionTitle>Post a manual journal</SectionTitle>
      <form action={postManualJournalAction} className="card p-4 grid sm:grid-cols-2 gap-3 mb-6">
        <Field label="Date"><input type="date" name="entryDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
        <Field label="Amount"><input type="number" step="0.01" name="amount" required className="input" /></Field>
        <Field label="Debit account">
          <select name="debitAccountId" required className="select"><option value="">— choose —</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </select>
        </Field>
        <Field label="Credit account">
          <select name="creditAccountId" required className="select"><option value="">— choose —</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-2"><Field label="Memo"><input name="memo" className="input" placeholder="What is this entry for?" /></Field></div>
        <div className="sm:col-span-2 flex justify-end"><button className="btn btn-primary" type="submit">Post entry</button></div>
      </form>

      <SectionTitle>Posted entries</SectionTitle>
      {entries.length === 0 ? <Empty title="No journal entries yet" hint="Recorded expenditures post here automatically, or add a manual entry above." /> : (
        <div className="space-y-3">
          {entries.map((e) => (
            <div key={e.id} className="card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs" style={{ color: "var(--brand)" }}>{e.entryNo}</span>
                  <span className="text-sm">{fmtDate(e.entryDate)}</span>
                  <Badge tone="muted">{e.sourceType}</Badge>
                  {e.isReversal && <Badge tone="info">reversal</Badge>}
                  {e.reversed && <Badge tone="warn">reversed</Badge>}
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular-nums font-medium">{money(e.total, c)}</span>
                  {!e.reversed && !e.isReversal && (
                    <form action={reverseJournalAction}>
                      <input type="hidden" name="entryId" value={e.id} />
                      <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Reverse</button>
                    </form>
                  )}
                </div>
              </div>
              {e.memo && <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>{e.memo}</div>}
              <table className="w-full text-sm mt-2">
                <thead><tr><th className="th text-left">Account</th><th className="th text-right">Debit</th><th className="th text-right">Credit</th></tr></thead>
                <tbody>
                  {(linesByEntry.get(e.id) ?? []).map((l, i) => (
                    <tr key={i}>
                      <td className="td"><span className="font-mono text-xs" style={{ color: "var(--muted)" }}>{l.code}</span> {l.name}</td>
                      <td className="td text-right tabular-nums">{l.debit ? money(l.debit, c) : ""}</td>
                      <td className="td text-right tabular-nums">{l.credit ? money(l.credit, c) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
