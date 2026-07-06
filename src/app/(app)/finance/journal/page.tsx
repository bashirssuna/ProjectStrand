import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { postManualJournalAction, reverseJournalAction, archiveOldJournalAction, setJournalArchivedAction } from "@/app/actions";

export default async function JournalPage({ searchParams }: {
  searchParams: Promise<{ posted?: string; reversed?: string; err?: string; project?: string; showArchived?: string; archived?: string; restored?: string }>
}) {
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;
  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]))?.currency ?? "USD";

  const accounts = await q<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND is_active ORDER BY code`, [orgId]
  );
  const projects = await q<{ id: string; code: string; title: string }>(
    `SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [orgId]
  );

  // --- filters: by project (id | 'none' = institutional | '' = all) and archived visibility
  const proj = sp.project ?? "";
  const showArchived = sp.showArchived === "1";
  const params: unknown[] = [orgId];
  let whereProj = `je.org_id = $1`;
  if (proj === "none") whereProj += ` AND je.project_id IS NULL`;
  else if (proj) { params.push(proj); whereProj += ` AND je.project_id = $${params.length}`; }
  const where = whereProj + (showArchived ? "" : " AND je.archived = false");

  // counts (respect the project filter, ignore the archived toggle) for the summary line
  const counts = (await one<{ total: number; archived: number }>(
    `SELECT COUNT(*)::int AS total, COALESCE(SUM(CASE WHEN archived THEN 1 ELSE 0 END),0)::int AS archived
     FROM journal_entry je WHERE ${whereProj}`, params
  )) ?? { total: 0, archived: 0 };

  const entries = await q<{
    id: string; entryNo: string; entryDate: string; memo: string | null; reference: string | null; sourceType: string;
    postedByName: string | null; total: number; reversed: boolean; isReversal: boolean; archived: boolean;
    projectCode: string | null; projectName: string | null;
  }>(
    `SELECT je.id, je.entry_no AS "entryNo", je.entry_date AS "entryDate", je.memo, je.reference, je.source_type AS "sourceType",
            je.posted_by_name AS "postedByName", je.archived,
            pr.code AS "projectCode", pr.title AS "projectName",
            COALESCE((SELECT SUM(debit) FROM journal_line WHERE entry_id=je.id),0)::float AS total,
            EXISTS(SELECT 1 FROM journal_entry r WHERE r.reverses_entry_id=je.id) AS reversed,
            (je.reverses_entry_id IS NOT NULL) AS "isReversal"
     FROM journal_entry je
     LEFT JOIN project pr ON pr.id = je.project_id
     WHERE ${where} ORDER BY je.created_at DESC LIMIT 100`, params
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

  // preserve active filters across the show/hide-archived links
  const withParams = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    if (proj) u.set("project", proj);
    if (showArchived) u.set("showArchived", "1");
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) u.delete(k); else u.set(k, v); }
    const s = u.toString();
    return `/finance/journal${s ? `?${s}` : ""}`;
  };
  const selProject = proj && proj !== "none" ? projects.find((p) => p.id === proj) : undefined;

  return (
    <div className="max-w-5xl">
      <PageHeader title="General journal" subtitle="Every posted ledger entry, organised by project" actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.posted && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Journal entry posted.</div>}
      {sp.reversed && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Entry reversed.</div>}
      {sp.archived && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>{sp.archived === "1" ? "Entry archived." : `Archived ${sp.archived} entr${sp.archived === "1" ? "y" : "ies"}.`}</div>}
      {sp.restored && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Entry restored.</div>}
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
        <Field label="Project (optional)">
          <select name="projectId" className="select" defaultValue={selProject?.id ?? ""}>
            <option value="">— Institutional (no project) —</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.title}</option>)}
          </select>
        </Field>
        <Field label="Reference"><input name="reference" className="input" placeholder="Voucher / invoice / receipt no." /></Field>
        <div className="sm:col-span-2"><Field label="Memo"><input name="memo" className="input" placeholder="What is this entry for?" /></Field></div>
        <div className="sm:col-span-2 flex justify-end"><button className="btn btn-primary" type="submit">Post entry</button></div>
      </form>

      <SectionTitle>Posted entries</SectionTitle>

      {/* Filters + housekeeping */}
      <div className="card p-4 mb-4 flex flex-wrap items-end gap-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <Field label="Project">
            <select name="project" defaultValue={proj} className="select">
              <option value="">All projects</option>
              <option value="none">Institutional (no project)</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.title}</option>)}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm mb-2">
            <input type="checkbox" name="showArchived" value="1" defaultChecked={showArchived} /> Show archived
          </label>
          <button className="btn btn-sm mb-1" type="submit">Apply</button>
          {(proj || showArchived) && <Link href="/finance/journal" className="btn btn-sm mb-1">Reset</Link>}
        </form>
        <div className="flex-1" />
        <form action={archiveOldJournalAction} className="flex items-end gap-2">
          <Field label="Archive entries older than">
            <select name="months" defaultValue="12" className="select">
              <option value="3">3 months</option>
              <option value="6">6 months</option>
              <option value="12">12 months</option>
              <option value="24">24 months</option>
            </select>
          </Field>
          <button className="btn btn-sm mb-1" type="submit" title="Archived entries are hidden here but still count in every statement">Archive old</button>
        </form>
      </div>

      <div className="text-sm mb-3" style={{ color: "var(--muted)" }}>
        Showing {entries.length} of {counts.total} entr{counts.total === 1 ? "y" : "ies"}
        {selProject ? ` for ${selProject.code}` : proj === "none" ? " (institutional)" : ""}
        {counts.archived > 0 && !showArchived && <> · {counts.archived} archived hidden (<Link href={withParams({ showArchived: "1" })} style={{ color: "var(--brand)" }}>show</Link>)</>}
        {showArchived && counts.archived > 0 && <> · including {counts.archived} archived (<Link href={withParams({ showArchived: undefined })} style={{ color: "var(--brand)" }}>hide</Link>)</>}
        . Archived entries are hidden from this list but still post to every financial statement.
      </div>

      {entries.length === 0 ? <Empty title="No journal entries" hint="Recorded expenditures post here automatically, or add a manual entry above. Try clearing the project filter or showing archived entries." /> : (
        <div className="space-y-3">
          {entries.map((e) => (
            <div key={e.id} className="card p-4" style={e.archived ? { opacity: 0.7 } : undefined}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs" style={{ color: "var(--brand)" }}>{e.entryNo}</span>
                  {e.projectCode
                    ? <span title={e.projectName ?? undefined}><Badge tone="info">{e.projectCode}</Badge></span>
                    : <Badge tone="muted">Institutional</Badge>}
                  {e.reference && <Badge tone="muted">Ref: {e.reference}</Badge>}
                  <span className="text-sm">{fmtDate(e.entryDate)}</span>
                  <Badge tone="muted">{e.sourceType}</Badge>
                  {e.isReversal && <Badge tone="info">reversal</Badge>}
                  {e.reversed && <Badge tone="warn">reversed</Badge>}
                  {e.archived && <Badge tone="muted">archived</Badge>}
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular-nums font-medium">{money(e.total, c)}</span>
                  {!e.reversed && !e.isReversal && (
                    <form action={reverseJournalAction}>
                      <input type="hidden" name="entryId" value={e.id} />
                      <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Reverse</button>
                    </form>
                  )}
                  <form action={setJournalArchivedAction}>
                    <input type="hidden" name="entryId" value={e.id} />
                    <input type="hidden" name="archive" value={e.archived ? "0" : "1"} />
                    <button className="btn btn-sm" type="submit">{e.archived ? "Restore" : "Archive"}</button>
                  </form>
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
