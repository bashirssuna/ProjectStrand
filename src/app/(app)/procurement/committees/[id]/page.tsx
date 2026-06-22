import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireProcOrg } from "../../_guard";
import { isModuleEnabled } from "@/server/modules";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty } from "@/components/ui";
import { label } from "@/lib/enums";
import { fmtDate } from "@/lib/format";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { updateCommitteeAction, deleteCommitteeAction, addCommitteeMemberAction, removeCommitteeMemberAction } from "@/app/actions";

const TYPES = ["contracts", "evaluation", "bid_opening", "disposal", "other"];
const ROLES = ["chairperson", "secretary", "member"];

export default async function CommitteeDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const { orgId } = await requireProcOrg();
  if (!(await isModuleEnabled(orgId, "public_procurement"))) redirect("/procurement");
  const sp = await searchParams;

  const c = await one<{ id: string; type: string; name: string; mandate: string | null; status: string }>(
    `SELECT id, type, name, mandate, status FROM proc_committee WHERE id=$1 AND org_id=$2`, [id, orgId]
  );
  if (!c) notFound();
  const members = await q<{ id: string; memberName: string; title: string | null; role: string; appointed: string | null; userId: string | null }>(
    `SELECT id, member_name AS "memberName", title, committee_role AS role, appointed_date::text AS appointed, user_id AS "userId"
     FROM proc_committee_member WHERE committee_id=$1
     ORDER BY CASE committee_role WHEN 'chairperson' THEN 0 WHEN 'secretary' THEN 1 ELSE 2 END, member_name`, [id]
  );
  const users = await q<{ id: string; name: string }>(`SELECT u.id, u.name FROM app_user u JOIN org_membership m ON m.user_id=u.id WHERE m.org_id=$1 ORDER BY u.name`, [orgId]);

  return (
    <div className="max-w-3xl">
      <PageHeader title={c.name} subtitle={`${label(c.type)} committee`} actions={<div className="flex gap-2">
        <form action={deleteCommitteeAction} className="inline"><input type="hidden" name="committeeId" value={c.id} /><ConfirmSubmit message="Delete this committee and its membership?"><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button></ConfirmSubmit></form>
        <Link href="/procurement/committees" className="btn btn-sm">← Committees</Link>
      </div>} />

      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Committee created.</div>}
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.added && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Member added.</div>}
      {sp.removed && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)" }}>Member removed.</div>}

      <div className="card p-4 mb-5">
        <div className="flex items-center gap-2 mb-3"><StatusBadge status={c.status} /></div>
        <form action={updateCommitteeAction} className="grid sm:grid-cols-2 gap-3">
          <input type="hidden" name="committeeId" value={c.id} />
          <Field label="Type"><select name="type" defaultValue={c.type} className="select">{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
          <Field label="Name"><input name="name" required defaultValue={c.name} className="input" /></Field>
          <Field label="Status"><select name="status" defaultValue={c.status} className="select"><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>
          <div className="sm:col-span-2"><Field label="Mandate / terms of reference"><textarea name="mandate" rows={2} defaultValue={c.mandate ?? ""} className="textarea" /></Field></div>
          <div><button className="btn btn-sm btn-primary" type="submit">Save</button></div>
        </form>
      </div>

      <div className="card p-4">
        <SectionTitle>Members</SectionTitle>
        {members.length === 0 ? <Empty title="No members yet" hint="Add the chairperson, secretary and members." /> : (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Name</th><th className="th text-left">Role</th><th className="th text-left">Title</th><th className="th text-left">Appointed</th><th className="th" /></tr></thead>
            <tbody>{members.map((m) => (
              <tr key={m.id}>
                <td className="td">{m.memberName}</td>
                <td className="td"><Badge tone={m.role === "chairperson" ? "brand" : m.role === "secretary" ? "info" : "muted"}>{label(m.role)}</Badge></td>
                <td className="td">{m.title ?? "—"}</td>
                <td className="td whitespace-nowrap">{m.appointed ? fmtDate(m.appointed) : "—"}</td>
                <td className="td text-right">
                  <form action={removeCommitteeMemberAction} className="inline"><input type="hidden" name="committeeId" value={c.id} /><input type="hidden" name="memberId" value={m.id} />
                    <ConfirmSubmit message="Remove this member?"><button className="text-xs hover:underline" type="submit" style={{ color: "var(--danger)" }}>remove</button></ConfirmSubmit>
                  </form>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <form action={addCommitteeMemberAction} className="grid sm:grid-cols-5 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="committeeId" value={c.id} />
          <Field label="Member (staff)"><select name="memberUserId" className="select"><option value="">— external —</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
          <Field label="…or name"><input name="memberName" className="input" placeholder="If not staff" /></Field>
          <Field label="Role"><select name="committeeRole" defaultValue="member" className="select">{ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
          <Field label="Title"><input name="title" className="input" placeholder="e.g. Head of Finance" /></Field>
          <div className="flex gap-2"><Field label="Appointed"><input type="date" name="appointedDate" className="input" /></Field><button className="btn btn-sm btn-primary" type="submit" style={{ alignSelf: "flex-end" }}>Add</button></div>
        </form>
      </div>
    </div>
  );
}
