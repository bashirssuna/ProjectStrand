import Link from "next/link";
import { requireCollabOrg } from "./_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { label } from "@/lib/enums";
import { addCollaboratorAction } from "@/app/actions";

const TYPES = [["institution", "Institution"], ["individual", "Individual"], ["funder", "Funder"], ["partner_ngo", "Partner NGO"], ["government", "Government"]];

export default async function CollaborationsPage({ searchParams }: { searchParams: Promise<{ created?: string; err?: string }> }) {
  const { orgId, orgName } = await requireCollabOrg();
  const sp = await searchParams;
  const collaborators = await q<{ id: string; prefix: string | null; name: string; organisation: string | null; collaboratorType: string; country: string | null; email: string | null; status: string; projectCount: number }>(
    `SELECT c.id, c.prefix, c.name, c.organisation, c.collaborator_type AS "collaboratorType", c.country, c.email, c.status,
            (SELECT COUNT(*)::int FROM project_collaborator pc WHERE pc.collaborator_id=c.id) AS "projectCount"
     FROM collaborator c WHERE c.org_id=$1 ORDER BY c.name`, [orgId]
  );

  return (
    <div className="max-w-5xl">
      <PageHeader title="Collaborations" subtitle={`External partners & collaborators for ${orgName}`} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Collaborator added.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A name is required.</div>}

      <SectionTitle>Partners &amp; collaborators</SectionTitle>
      {collaborators.length === 0 ? <Empty title="No collaborators yet" hint="Add external partners, co-investigators, funders and sub-grantees below, then link them to projects with a role." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Name</th><th className="th text-left">Home institution</th><th className="th text-left">Type</th><th className="th text-left">Country</th><th className="th text-right">Projects</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {collaborators.map((c) => (
                <tr key={c.id}>
                  <td className="td font-medium">{c.prefix ? `${c.prefix} ` : ""}{c.name}</td>
                  <td className="td">{c.organisation ?? "—"}</td>
                  <td className="td">{label(c.collaboratorType)}</td>
                  <td className="td">{c.country ?? "—"}</td>
                  <td className="td text-right tabular-nums">{c.projectCount}</td>
                  <td className="td">{c.status === "active" ? <Badge tone="ok">active</Badge> : <Badge tone="muted">inactive</Badge>}</td>
                  <td className="td text-right"><Link href={`/collaborations/${c.id}`} className="btn btn-sm">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Add a collaborator</SectionTitle>
      <form action={addCollaboratorAction} className="card p-4 grid sm:grid-cols-3 gap-3">
        <Field label="Prefix"><input name="prefix" className="input" placeholder="Dr, Prof…" /></Field>
        <div className="sm:col-span-2"><Field label="Name"><input name="name" required className="input" placeholder="Person or organisation name" /></Field></div>
        <Field label="Type"><select name="collaboratorType" className="select">{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <div className="sm:col-span-2"><Field label="Home institution"><input name="organisation" className="input" /></Field></div>
        <Field label="Email"><input name="email" className="input" /></Field>
        <Field label="Phone"><input name="phone" className="input" /></Field>
        <Field label="Country"><input name="country" className="input" /></Field>
        <div className="sm:col-span-2"><Field label="Area of expertise"><input name="expertise" className="input" placeholder="e.g. Epidemiology, Health economics" /></Field></div>
        <Field label="Website"><input name="website" className="input" /></Field>
        <div className="sm:col-span-3"><Field label="Address"><input name="address" className="input" /></Field></div>
        <div className="sm:col-span-3"><Field label="Note"><input name="note" className="input" /></Field></div>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Add collaborator</button></div>
      </form>
    </div>
  );
}
