import Link from "next/link";
import { requireLabOrg } from "../_guard";
import { accessibleProjectIds, listParticipants, canSeePII, maskName } from "@/server/services/lab";
import { PageHeader, Field, Badge, Empty, Stat } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";

const CONSENT = ["valid", "expired", "withdrawn"];
const consentTone = (s: string) => (s === "valid" ? "ok" : s === "expired" ? "warn" : "danger") as "ok" | "warn" | "danger";

export default async function Participants({ searchParams }: { searchParams: Promise<{ search?: string; consent?: string }> }) {
  const { orgId, orgName, userId, isOrgAdmin, isSuperAdmin } = await requireLabOrg();
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const seePII = canSeePII(isOrgAdmin, isSuperAdmin);
  const sp = await searchParams;
  const projectIds = await accessibleProjectIds(userId, orgId, isAdmin);
  const rows = await listParticipants(orgId, projectIds, { search: sp.search, consent: sp.consent });
  const withdrawn = rows.filter((r) => r.consentStatus === "withdrawn").length;

  return (
    <div className="max-w-5xl">
      <PageHeader title="Participants" subtitle={`Enrolled subjects & their visits — ${orgName}`} actions={<Link href="/lab" className="btn btn-sm">← Laboratory</Link>} />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <Stat label="Participants" value={String(rows.length)} />
        <Stat label="Consent valid" value={String(rows.filter((r) => r.consentStatus === "valid").length)} />
        <Stat label="Withdrawn" value={String(withdrawn)} tone={withdrawn > 0 ? "warn" : undefined} />
      </div>

      <form className="card p-4 mb-5 grid sm:grid-cols-3 gap-3 items-end">
        <Field label="Search"><input name="search" defaultValue={sp.search ?? ""} className="input" placeholder="Study ID or name" /></Field>
        <Field label="Consent"><select name="consent" defaultValue={sp.consent ?? ""} className="select"><option value="">All</option>{CONSENT.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
        <div className="flex gap-2"><button className="btn btn-sm btn-primary" type="submit">Filter</button><Link href="/lab/participants" className="btn btn-sm">Reset</Link></div>
      </form>

      {rows.length === 0 ? (
        <Empty title="No participants" hint="Participants appear here once samples are registered against a study ID." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Study ID</th><th className="th text-left">Name</th><th className="th text-left">Enrolled</th><th className="th text-left">Consent</th><th className="th text-right">Visits</th><th className="th text-right">Samples</th><th className="th text-left">Last sample</th><th className="th" /></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="td"><Link href={`/lab/participants/${p.id}`} className="font-medium hover:underline" style={{ color: "var(--brand)" }}>{p.studyId}</Link></td>
                  <td className="td">{maskName(p.name, seePII)}</td>
                  <td className="td whitespace-nowrap">{fmtDate(p.enrollmentDate)}</td>
                  <td className="td"><Badge tone={consentTone(p.consentStatus)}>{label(p.consentStatus)}</Badge></td>
                  <td className="td text-right tabular-nums">{p.visitCount}</td>
                  <td className="td text-right tabular-nums">{p.sampleCount}</td>
                  <td className="td whitespace-nowrap">{p.lastCollection ? fmtDate(p.lastCollection) : "—"}</td>
                  <td className="td text-right"><Link href={`/lab/participants/${p.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
