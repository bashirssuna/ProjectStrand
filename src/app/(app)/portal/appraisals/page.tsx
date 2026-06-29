import Link from "next/link";
import { requirePortalEmployee } from "../_guard";
import { listAppraisalsForUser } from "@/server/services/appraisals";
import { PageHeader, SectionTitle, StatusBadge, Empty } from "@/components/ui";
import { ratingLabel } from "@/server/services/appraisals";

export default async function PortalAppraisalsPage() {
  const { orgId, employeeId, name } = await requirePortalEmployee();
  const rows = await listAppraisalsForUser(orgId, employeeId);
  const mine = rows.filter((r) => r.role === "appraisee");
  const conducting = rows.filter((r) => r.role === "appraiser");

  const tableFor = (list: typeof rows, asAppraiser: boolean) => (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr><th className="th text-left">Cycle</th>{asAppraiser && <th className="th text-left">Appraisee</th>}<th className="th text-left">Status</th><th className="th text-left">Overall</th><th className="th" /></tr></thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id}>
              <td className="td font-medium">{r.cycleName}</td>
              {asAppraiser && <td className="td">{r.employeeName}</td>}
              <td className="td"><StatusBadge status={r.status} /></td>
              <td className="td">{r.overallRating != null ? `${r.overallRating} — ${ratingLabel(r.overallRating)}` : "—"}</td>
              <td className="td text-right"><Link href={`/portal/appraisals/${r.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="max-w-3xl">
      <PageHeader title="My appraisals" subtitle={`Performance reviews for ${name}`} actions={<Link href="/portal" className="btn btn-sm">← Portal</Link>} />

      <SectionTitle>My performance reviews</SectionTitle>
      <div className="mt-2 mb-6">
        {mine.length === 0 ? <Empty title="No appraisals yet" hint="Your reviews will appear here when HR opens a cycle for you." /> : tableFor(mine, false)}
      </div>

      {conducting.length > 0 && (
        <>
          <SectionTitle>Appraisals I conduct</SectionTitle>
          <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Staff for whom you are the appraiser.</p>
          <div className="mt-1">{tableFor(conducting, true)}</div>
        </>
      )}
    </div>
  );
}
