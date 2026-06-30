import Link from "next/link";
import { requireHrOrg } from "../_guard";
import { listSurveys } from "@/server/services/surveys";
import { PageHeader, SectionTitle, Field, StatusBadge, Badge, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { createSurveyAction } from "@/app/actions";

export default async function SurveysPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireHrOrg();
  const sp = await searchParams;
  const surveys = await listSurveys(orgId);

  return (
    <div className="max-w-4xl">
      <PageHeader title="Engagement surveys" subtitle={`Staff satisfaction & engagement surveys for ${orgName}`} actions={<Link href="/hr" className="btn btn-sm">← HR</Link>} />
      {sp.err === "title" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A survey title is required.</div>}

      <SectionTitle>Surveys</SectionTitle>
      <div className="mt-2 mb-6">
        {surveys.length === 0 ? <Empty title="No surveys" hint="Create a staff engagement survey below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Title</th><th className="th text-left">Questions</th><th className="th text-left">Responses</th><th className="th text-left">Mode</th><th className="th text-left">Created</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
              <tbody>
                {surveys.map((s) => (
                  <tr key={s.id}>
                    <td className="td font-medium">{s.title}</td>
                    <td className="td">{s.questions}</td>
                    <td className="td">{s.responses}</td>
                    <td className="td">{s.anonymous ? <Badge tone="info">Anonymous</Badge> : <Badge tone="muted">Identified</Badge>}</td>
                    <td className="td whitespace-nowrap">{fmtDate(s.createdAt)}</td>
                    <td className="td"><StatusBadge status={s.status} /></td>
                    <td className="td text-right"><Link href={`/hr/surveys/${s.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card p-4">
        <SectionTitle>New survey</SectionTitle>
        <form action={createSurveyAction} className="grid gap-3 mt-2">
          <Field label="Title *"><input name="title" required className="input" placeholder="e.g. 2026 Staff Engagement Survey" /></Field>
          <Field label="Description (internal)"><input name="description" className="input" /></Field>
          <Field label="Intro shown to respondents"><textarea name="intro" rows={2} className="input" placeholder="Your honest feedback helps us improve. This survey is anonymous." /></Field>
          <Field label="Thank-you message"><input name="thankYou" className="input" placeholder="Thank you for your feedback." /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="anonymous" defaultChecked /> Anonymous (don&apos;t capture respondent identity)</label>
          <div><button className="btn btn-primary" type="submit">Create survey</button></div>
        </form>
      </div>
    </div>
  );
}
