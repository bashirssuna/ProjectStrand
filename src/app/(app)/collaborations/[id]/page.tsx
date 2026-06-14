import Link from "next/link";
import { requireCollabOrg } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { label } from "@/lib/enums";
import { updateCollaboratorStatusAction, linkCollaboratorToProjectAction, unlinkCollaboratorFromProjectAction, createCollaboratorLoginAction } from "@/app/actions";

const ROLES = [["co_investigator", "Co-Investigator"], ["partner", "Partner"], ["funder", "Funder"], ["advisor", "Advisor"], ["sub_grantee", "Sub-grantee"], ["collaborator", "Collaborator"]];

export default async function CollaboratorDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ linked?: string; err?: string; login?: string; loginerr?: string }> }) {
  const { id } = await params;
  const { orgId } = await requireCollabOrg();
  const sp = await searchParams;
  const c = await one<{
    id: string; prefix: string | null; name: string; organisation: string | null; collaboratorType: string;
    email: string | null; phone: string | null; country: string | null; address: string | null; expertise: string | null;
    website: string | null; status: string; note: string | null; userId: string | null;
  }>(
    `SELECT id, prefix, name, organisation, collaborator_type AS "collaboratorType", email, phone, country, address,
            expertise, website, status, note, user_id AS "userId" FROM collaborator WHERE id=$1 AND org_id=$2`, [id, orgId]
  );
  if (!c) return <Empty title="Collaborator not found" hint="They may have been removed." />;
  const links = await q<{ id: string; role: string; responsibilities: string | null; projectId: string; code: string; title: string }>(
    `SELECT pc.id, pc.role, pc.responsibilities, p.id AS "projectId", p.code, p.title
     FROM project_collaborator pc JOIN project p ON p.id=pc.project_id WHERE pc.collaborator_id=$1 ORDER BY p.created_at DESC`, [id]
  );
  const linkedIds = new Set(links.map((l) => l.projectId));
  const projects = (await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY created_at DESC`, [orgId])).filter((p) => !linkedIds.has(p.id));

  return (
    <div className="max-w-4xl">
      <PageHeader title={`${c.prefix ? `${c.prefix} ` : ""}${c.name}`} subtitle={`${label(c.collaboratorType)}${c.organisation ? ` · ${c.organisation}` : ""}`}
        actions={<div className="flex gap-2">
          <form action={updateCollaboratorStatusAction}><input type="hidden" name="collaboratorId" value={c.id} /><button className="btn btn-sm" type="submit">{c.status === "active" ? "Mark inactive" : "Mark active"}</button></form>
          <Link href="/collaborations" className="btn btn-sm">← All</Link>
        </div>} />
      {sp.linked && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Linked to project.</div>}
      {sp.login === "sent" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>View-only login created — an invite email with a set-password link has been sent.</div>}
      {sp.login === "exists" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)", borderColor: "var(--border)" }}>This collaborator already has a login.</div>}
      {sp.login === "failed" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>Login created, but the invite email could not be sent. They can use “forgot password” to set one.</div>}
      {sp.loginerr && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{decodeURIComponent(sp.loginerr)}</div>}

      <SectionTitle>View-only access</SectionTitle>
      <div className="card p-4 mb-6">
        {c.userId ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>This collaborator has a portal login. They can sign in to see only the projects they're linked to, and within each only the Overview, Statement of Work, Work plan, Gantt and Objectives tabs — never budget, spending, requisitions or other internal pages.</p>
        ) : (
          <>
            <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>{c.email ? "Grant a restricted, view-only login and email them an invite to set a password. They'll see only the projects they're linked to (Overview, SOW, Work plan, Gantt, Objectives)." : "Add an email address (edit the collaborator) before creating a login."}</p>
            {c.email && <form action={createCollaboratorLoginAction}><input type="hidden" name="collaboratorId" value={c.id} /><button className="btn btn-primary btn-sm" type="submit">Create view-only login</button></form>}
          </>
        )}
      </div>

      <SectionTitle>Details</SectionTitle>
      <div className="card p-4 mb-6 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {[["Status", c.status], ["Email", c.email], ["Phone", c.phone], ["Country", c.country], ["Expertise", c.expertise], ["Website", c.website], ["Address", c.address], ["Note", c.note]].map(([k, v]) => (
          <div key={k as string} className="flex justify-between gap-4 border-b py-1" style={{ borderColor: "var(--border)" }}>
            <span style={{ color: "var(--muted)" }}>{k}</span><span className="text-right">{v || "—"}</span>
          </div>
        ))}
      </div>

      <SectionTitle>Project roles</SectionTitle>
      {links.length === 0 ? <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>Not linked to any project yet.</p> : (
        <div className="card overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Project</th><th className="th text-left">Role</th><th className="th text-left">Responsibilities</th><th className="th" /></tr></thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td className="td"><Link href={`/projects/${l.projectId}`} className="hover:underline" style={{ color: "var(--brand)" }}>{l.code}</Link> {l.title}</td>
                  <td className="td"><Badge tone="info">{label(l.role)}</Badge></td>
                  <td className="td">{l.responsibilities ?? "—"}</td>
                  <td className="td text-right"><form action={unlinkCollaboratorFromProjectAction}><input type="hidden" name="collaboratorId" value={c.id} /><input type="hidden" name="linkId" value={l.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Remove</button></form></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {projects.length > 0 && (
        <>
          <SectionTitle>Link to a project</SectionTitle>
          <form action={linkCollaboratorToProjectAction} className="card p-4 grid sm:grid-cols-3 gap-3">
            <input type="hidden" name="collaboratorId" value={c.id} />
            <Field label="Project"><select name="projectId" required className="select"><option value="">— choose —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.title}</option>)}</select></Field>
            <Field label="Role"><select name="role" className="select">{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Responsibilities"><input name="responsibilities" className="input" /></Field>
            <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Link to project</button></div>
          </form>
        </>
      )}
    </div>
  );
}
