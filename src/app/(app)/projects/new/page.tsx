import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { canCreateProjects } from "@/server/policy";
import { createProjectAction } from "@/app/actions";
import { PageHeader, Field } from "@/components/ui";

export default async function NewProjectPage() {
  const user = await requireUser();
  if (!(await canCreateProjects(user.id, user.isSuperAdmin))) redirect("/projects");
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-2xl">
      <PageHeader title="New project" subtitle="Set up the essentials. You can upload documents next and let Strand draft the rest." />

      <form action={createProjectAction} className="card p-6 space-y-5">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Project code">
            <input name="code" required placeholder="CRSA-2025" className="input" />
          </Field>
          <Field label="Currency">
            <select name="currency" className="select" defaultValue="USD">
              {["USD", "UGX", "EUR", "GBP", "KES", "TZS", "RWF", "NGN", "ZAR"].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Title">
          <input name="title" required placeholder="Climate-Resilient Smallholder Agriculture" className="input" />
        </Field>

        <Field label="Summary">
          <textarea name="summary" rows={3} placeholder="One or two sentences describing the project." className="textarea" />
        </Field>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Donor / funder">
            <input name="donor" placeholder="Global Climate Fund" className="input" />
          </Field>
          <Field label="Grant number">
            <input name="grantNumber" placeholder="GCF-2025-0142" className="input" />
          </Field>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Start date">
            <input type="date" name="startDate" defaultValue={today} className="input" />
          </Field>
          <Field label="End date">
            <input type="date" name="endDate" className="input" />
          </Field>
        </div>

        <Field label="Mode">
          <select name="mode" className="select" defaultValue="advanced">
            <option value="advanced">Advanced — full grant management (budget, requisitions, logframe)</option>
          </select>
        </Field>

        {user.isSuperAdmin && (
          <div className="card p-4 grid sm:grid-cols-2 gap-4" style={{ background: "var(--surface)" }}>
            <div className="sm:col-span-2 text-sm font-medium">Assign Principal Investigator</div>
            <Field label="PI email"><input type="email" name="piEmail" className="input" placeholder="pi@org.org" /></Field>
            <Field label="PI name"><input name="piName" className="input" placeholder="Dr. Jane Doe" /></Field>
            <p className="sm:col-span-2 text-xs" style={{ color: "var(--muted)" }}>
              As an admin you won&apos;t be a project member. The PI you name here can run the project and add the rest of the team; they&apos;ll get an email to set their password.
            </p>
          </div>
        )}

        <div className="card p-4" style={{ background: "var(--surface)" }}>
          <Field label="Co-PIs / Co-Investigators (optional)"><input name="coPiEmails" className="input" placeholder="comma-separated emails" /></Field>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Co-PIs are added to the project with the same authority as the PI (approve the SOW, approve &amp; sign requisitions, manage the team, budget and reports). You can add or change them later on the Team page.</p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="withImport" value="1" defaultChecked />
          After creating, take me to document import (auto-generate pages)
        </label>

        <div className="flex items-center gap-3 pt-2">
          <button className="btn btn-primary" type="submit">Create project</button>
          <Link href="/projects" className="btn">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
