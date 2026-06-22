import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProcOrg } from "../_guard";
import { isModuleEnabled } from "@/server/modules";
import { listCommittees, committeeStats } from "@/server/services/proc_committees";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty, Stat } from "@/components/ui";
import { label } from "@/lib/enums";
import { createCommitteeAction } from "@/app/actions";

const TYPES = ["contracts", "evaluation", "bid_opening", "disposal", "other"];

export default async function Committees({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const { orgId, orgName } = await requireProcOrg();
  if (!(await isModuleEnabled(orgId, "public_procurement"))) redirect("/procurement");
  const sp = await searchParams;
  const [rows, stats] = await Promise.all([listCommittees(orgId), committeeStats(orgId)]);

  return (
    <div className="max-w-4xl">
      <PageHeader title="Procurement committees" subtitle={`Contracts, evaluation, bid opening & disposal committees for ${orgName}`} actions={<Link href="/procurement" className="btn btn-sm">← Procurement</Link>} />
      {sp.deleted && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)" }}>Committee deleted.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Committees" value={String(stats.total)} />
        <Stat label="Active" value={String(stats.active)} />
      </div>

      {rows.length === 0 ? (
        <Empty title="No committees yet" hint="Set up your Contracts, Evaluation, Bid Opening and Disposal committees and record their members." />
      ) : (
        <div className="card overflow-x-auto mb-5">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Committee</th><th className="th text-left">Type</th><th className="th text-left">Members</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="td"><Link href={`/procurement/committees/${c.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>{c.name}</Link></td>
                  <td className="td">{label(c.type)}</td>
                  <td className="td tabular-nums">{c.members}</td>
                  <td className="td"><StatusBadge status={c.status} /></td>
                  <td className="td text-right"><Link href={`/procurement/committees/${c.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card p-4">
        <SectionTitle>New committee</SectionTitle>
        <form action={createCommitteeAction} className="grid sm:grid-cols-2 gap-3">
          <Field label="Type"><select name="type" defaultValue="contracts" className="select">{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
          <Field label="Name"><input name="name" required className="input" placeholder="e.g. Contracts Committee" /></Field>
          <div className="sm:col-span-2"><Field label="Mandate / terms of reference"><textarea name="mandate" rows={2} className="textarea" placeholder="Role and authority of this committee" /></Field></div>
          <div><button className="btn btn-primary" type="submit">Create committee</button></div>
        </form>
        <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>This is phase one of the formal procurement pack. Tenders, bid opening &amp; evaluation, contract management and disposal will plug into these committees in the next updates.</p>
      </div>
    </div>
  );
}
