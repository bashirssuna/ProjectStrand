import Link from "next/link";
import { requireHrOrg } from "../_guard";
import { q } from "@/server/db";
import { listOpenings, openingStats } from "@/server/services/recruitment";
import { PageHeader, SectionTitle, Field, Stat, StatusBadge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { currencyOptions } from "@/lib/currencies";
import { createJobOpeningAction } from "@/app/actions";

const EMP_TYPES = ["full_time", "part_time", "fixed_term", "contract", "internship", "consultant"];
const OPENING_STATUSES = ["draft", "open", "on_hold", "closed", "filled", "cancelled"];

export default async function RecruitmentPage({ searchParams }: { searchParams: Promise<{ status?: string; search?: string; err?: string }> }) {
  const { orgId, orgName } = await requireHrOrg();
  const sp = await searchParams;
  const [openings, stats, depts, projects] = await Promise.all([
    listOpenings(orgId, { status: sp.status, search: sp.search }),
    openingStats(orgId),
    q<{ id: string; name: string }>(`SELECT id, name FROM department WHERE org_id=$1 ORDER BY name`, [orgId]),
    q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY created_at DESC LIMIT 200`, [orgId]),
  ]);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Recruitment" subtitle={`Job openings, candidates & hiring for ${orgName}`} actions={<Link href="/hr" className="btn btn-sm">← HR</Link>} />
      {sp.err === "title" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A job title is required.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Openings" value={String(stats.total)} />
        <Stat label="Open" value={String(stats.open)} tone={stats.open ? "warn" : undefined} />
        <Stat label="Candidates" value={String(stats.candidates)} />
        <Stat label="To review" value={String(stats.toReview)} tone={stats.toReview ? "warn" : undefined} />
      </div>

      <form className="card p-4 mb-5 grid sm:grid-cols-3 gap-3 items-end">
        <div><Field label="Search"><input name="search" defaultValue={sp.search ?? ""} className="input" placeholder="Title or reference" /></Field></div>
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="select"><option value="">All</option>{OPENING_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <div className="flex gap-2"><button className="btn btn-sm btn-primary" type="submit">Apply</button><Link href="/hr/recruitment" className="btn btn-sm">Reset</Link></div>
      </form>

      {openings.length === 0 ? (
        <Empty title="No job openings yet" hint="Create an opening below to start building a candidate pipeline." />
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Opening</th><th className="th text-left">Department</th><th className="th text-left">Type</th><th className="th text-right">Applicants</th><th className="th text-left">Closing</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {openings.map((o) => (
                <tr key={o.id}>
                  <td className="td"><div className="font-medium">{o.title}</div>{o.reference && <div className="text-xs font-mono" style={{ color: "var(--muted)" }}>{o.reference}</div>}</td>
                  <td className="td">{o.department ?? "—"}</td>
                  <td className="td">{label(o.employmentType)}</td>
                  <td className="td text-right tabular-nums">{o.applicants}</td>
                  <td className="td whitespace-nowrap">{o.closingDate ? fmtDate(o.closingDate) : "—"}</td>
                  <td className="td"><StatusBadge status={o.status} /></td>
                  <td className="td text-right"><Link href={`/hr/recruitment/${o.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card p-4">
        <SectionTitle>New job opening</SectionTitle>
        <form action={createJobOpeningAction} className="grid sm:grid-cols-2 gap-3 mt-2">
          <Field label="Job title *"><input name="title" required className="input" placeholder="e.g. Research Officer" /></Field>
          <Field label="Reference"><input name="reference" className="input" placeholder="e.g. ACHR/HR/2026/004" /></Field>
          <Field label="Department"><select name="departmentId" className="select"><option value="">—</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="…or new department"><input name="departmentName" className="input" placeholder="Type to create" /></Field>
          <Field label="Employment type"><select name="employmentType" defaultValue="full_time" className="select">{EMP_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
          <Field label="Positions"><input name="positions" type="number" min="1" defaultValue="1" className="input" /></Field>
          <Field label="Location"><input name="location" className="input" placeholder="e.g. Kampala" /></Field>
          <Field label="Linked project"><select name="projectId" className="select"><option value="">—</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.title}</option>)}</select></Field>
          <Field label="Salary range (min)"><input name="salaryMin" type="number" step="any" className="input" /></Field>
          <Field label="Salary range (max)"><input name="salaryMax" type="number" step="any" className="input" /></Field>
          <Field label="Currency"><select name="currency" className="select"><option value="">—</option>{currencyOptions().map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="Closing date"><input name="closingDate" type="date" className="input" /></Field>
          <Field label="Hiring manager"><input name="hiringManager" className="input" /></Field>
          <div className="sm:col-span-2"><Field label="Role summary (JD)"><textarea name="description" rows={3} className="input" placeholder="What the role is about" /></Field></div>
          <div className="sm:col-span-2"><Field label="Key responsibilities"><textarea name="responsibilities" rows={3} className="input" /></Field></div>
          <div className="sm:col-span-2"><Field label="Requirements / qualifications"><textarea name="requirements" rows={3} className="input" /></Field></div>
          <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Create opening</button></div>
        </form>
      </div>
    </div>
  );
}
