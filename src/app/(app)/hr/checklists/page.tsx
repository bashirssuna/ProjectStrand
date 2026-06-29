import Link from "next/link";
import { requireHrOrg } from "../_guard";
import { q } from "@/server/db";
import { listTemplates, listInstances, checklistStats, instanceProgress, CHECKLIST_TYPES } from "@/server/services/checklists";
import { PageHeader, SectionTitle, Field, Stat, StatusBadge, Badge, Empty, ProgressBar } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { createChecklistTemplateAction, startChecklistAction } from "@/app/actions";

const typeTone = (t: string) => (t === "onboarding" ? "ok" : t === "exit" ? "warn" : "info");

export default async function ChecklistsPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireHrOrg();
  const sp = await searchParams;
  const [templates, instances, stats, employees] = await Promise.all([
    listTemplates(orgId),
    listInstances(orgId, {}),
    checklistStats(orgId),
    q<{ id: string; name: string }>(`SELECT id, (first_name || ' ' || last_name) AS name FROM employee WHERE org_id=$1 ORDER BY first_name, last_name`, [orgId]),
  ]);
  const activeTemplates = templates.filter((t) => t.active);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Onboarding & exit" subtitle={`Induction, clearance & handover checklists for ${orgName}`} actions={<Link href="/hr" className="btn btn-sm">← HR</Link>} />
      {sp.err === "name" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A template name is required.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Onboarding open" value={String(stats.onboardingOpen)} tone={stats.onboardingOpen ? "ok" : undefined} />
        <Stat label="Exit / handover open" value={String(stats.exitOpen)} tone={stats.exitOpen ? "warn" : undefined} />
        <Stat label="Overdue" value={String(stats.overdue)} tone={stats.overdue ? "danger" : undefined} />
        <Stat label="Completed" value={String(stats.completed)} />
      </div>

      {/* Active checklists */}
      <SectionTitle>Active checklists</SectionTitle>
      <div className="mt-2 mb-4">
        {instances.length === 0 ? <Empty title="No checklists running" hint="Start one for an employee below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Checklist</th><th className="th text-left">Employee</th><th className="th text-left">Type</th><th className="th text-left">Progress</th><th className="th text-left">Due</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
              <tbody>
                {instances.map((c) => (
                  <tr key={c.id}>
                    <td className="td font-medium">{c.title}</td>
                    <td className="td">{c.employeeName ?? "—"}</td>
                    <td className="td"><Badge tone={typeTone(c.type)}>{label(c.type)}</Badge></td>
                    <td className="td" style={{ minWidth: 130 }}><div className="flex items-center gap-2"><ProgressBar value={c.total ? Math.round((c.done / c.total) * 100) : 0} /><span className="text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>{c.done}/{c.total}</span></div></td>
                    <td className="td whitespace-nowrap">{c.dueDate ? fmtDate(c.dueDate) : "—"}{c.overdue && <span className="ml-1" style={{ color: "var(--danger)" }}>•</span>}</td>
                    <td className="td"><StatusBadge status={c.status} /></td>
                    <td className="td text-right"><Link href={`/hr/checklists/${c.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Start a checklist */}
      {activeTemplates.length > 0 && (
        <div className="card p-4 mb-6">
          <SectionTitle>Start a checklist for an employee</SectionTitle>
          <form action={startChecklistAction} className="grid sm:grid-cols-4 gap-3 mt-2 items-end">
            <div className="sm:col-span-2"><Field label="Template *"><select name="templateId" required className="select">{activeTemplates.map((t) => <option key={t.id} value={t.id}>{label(t.type)} · {t.name} ({t.items} items)</option>)}</select></Field></div>
            <Field label="Employee"><select name="employeeId" className="select"><option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
            <Field label="Target completion"><input name="dueDate" type="date" className="input" /></Field>
            <div className="sm:col-span-4"><button className="btn btn-primary" type="submit">Start checklist</button></div>
          </form>
        </div>
      )}

      {/* Templates */}
      <div className="grid md:grid-cols-2 gap-5">
        <div>
          <SectionTitle>Templates</SectionTitle>
          <div className="mt-2 space-y-2">
            {templates.length === 0 ? <Empty title="No templates" hint="Create one to define a reusable checklist." /> : templates.map((t) => (
              <Link key={t.id} href={`/hr/checklists/template/${t.id}`} className="card p-3 flex items-center justify-between hover:opacity-90">
                <div><div className="font-medium text-sm">{t.name}</div><div className="text-xs" style={{ color: "var(--muted)" }}>{t.items} items{!t.active ? " · inactive" : ""}</div></div>
                <Badge tone={typeTone(t.type)}>{label(t.type)}</Badge>
              </Link>
            ))}
          </div>
        </div>
        <div className="card p-4 self-start">
          <SectionTitle>New template</SectionTitle>
          <form action={createChecklistTemplateAction} className="grid gap-3 mt-2">
            <Field label="Type"><select name="type" className="select">{CHECKLIST_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
            <Field label="Name *"><input name="name" required className="input" placeholder="e.g. Staff Induction Checklist" /></Field>
            <Field label="Description"><textarea name="description" rows={2} className="input" /></Field>
            <div><button className="btn btn-primary" type="submit">Create template</button></div>
          </form>
        </div>
      </div>
    </div>
  );
}
