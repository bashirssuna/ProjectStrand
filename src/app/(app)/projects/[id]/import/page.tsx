import Link from "next/link";
import { redirect } from "next/navigation";
import { one } from "@/server/db";
import { can } from "@/server/policy";
import { PageHeader } from "@/components/ui";
import { ImportForm } from "@/components/import-form";
import { blockStaff } from "../_staffblock";

export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await blockStaff(id);
  if (!(await can(id, "project.edit"))) redirect(`/projects/${id}`);
  const project = await one<{ title: string; code: string }>(`SELECT title, code FROM project WHERE id=$1`, [id]);
  if (!project) redirect("/projects");

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Import documents"
        subtitle={`Auto-generate pages for ${project.title} from existing documents.`}
        actions={<Link href={`/projects/${id}`} className="btn">Skip for now</Link>}
      />
      <div className="card p-4 mb-5 text-sm" style={{ background: "color-mix(in srgb, var(--info) 8%, transparent)" }}>
        Upload a proposal, work plan, budget or SOW from your computer — PDF, Word (.docx/.doc),
        Excel (.xlsx/.xls), CSV or text. Strand extracts a structured draft you review and accept;
        nothing is saved to the project until you approve it. Uploaded files are also filed in the
        project Documents. (You can paste text instead if you prefer.)
      </div>
      <ImportForm projectId={id} />
    </div>
  );
}
