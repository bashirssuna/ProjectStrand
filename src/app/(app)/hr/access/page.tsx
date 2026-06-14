import Link from "next/link";
import { requireHrOrg } from "../_guard";
import { PageHeader, SectionTitle, Badge } from "@/components/ui";
import { PROJECT_ROLES, PERMISSIONS, ROLE_PERMISSIONS, type Permission, type ProjectRole } from "@/lib/enums";

const PERM_LABEL: Record<Permission, string> = {
  "project.view": "View project", "project.comment": "Comment", "project.edit": "Edit content",
  "project.administer": "Administer", "members.manage": "Manage team", "budget.manage": "Manage budget",
  "documents.manage": "Manage documents", "reports.manage": "Manage reports", "requisitions.create": "Raise requisitions",
  "requisitions.approve": "Approve requisitions", "requisitions.sign": "Sign requisitions", "approvals.approve": "Approve items",
};
const ROLE_LABEL: Record<ProjectRole, string> = {
  pi: "Principal Investigator", project_manager: "Project Manager", finance_admin: "Finance Administrator",
  coordinator: "Coordinator", assistant: "Assistant", member: "Member", reviewer: "Reviewer",
  approver: "Approver", viewer: "Viewer",
};
const ROLE_NOTE: Record<ProjectRole, string> = {
  pi: "Full oversight of a project, but cannot raise requisitions (separation of duties — they approve and sign instead).",
  project_manager: "Full control of a project, including raising requisitions.",
  finance_admin: "Budget, reports and the full requisition workflow; does not edit project content.",
  coordinator: "Edits content, manages documents and reports, and raises requisitions.",
  assistant: "Edits project content and comments.",
  member: "Views and comments.",
  reviewer: "Views, comments and approves items.",
  approver: "Approves and signs requisitions.",
  viewer: "Read-only.",
};

const MODULES: [string, string, string][] = [
  ["Finance & Accounting", "/finance", "Ledger, statements, invoices, receipts, assets, reconciliation, currency, financial years and sub-awards."],
  ["Human Resources", "/hr", "Employee records, compensation, departments, leave, documents and project staffing."],
  ["Procurement", "/procurement", "Suppliers, purchase requests and procurement workflow."],
  ["Sub-awards", "/subawards", "Pass-through grants to partner organisations and their disbursements."],
  ["Collaborations", "/collaborations", "External partner organisations and their project links."],
  ["Organisation settings", "/organization", "Members, roles and organisation configuration."],
];

export default async function AccessOverviewPage() {
  await requireHrOrg();

  return (
    <div className="max-w-5xl">
      <PageHeader title="Access overview" subtitle="Who can see and do what" actions={<div className="flex gap-2"><Link href="/hr/access/manage" className="btn btn-sm btn-primary">Manage access</Link><Link href="/hr" className="btn btn-sm">← HR</Link></div>} />

      <div className="card p-4 mb-5" style={{ borderColor: "var(--brand)" }}>
        <div className="font-display font-semibold">Manage who has access</div>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>This page explains what each role can do. To see every user&apos;s actual rights and change roles or fine-grained permissions — for an individual or a whole department — open <Link href="/hr/access/manage" className="hover:underline" style={{ color: "var(--brand)" }}>Access management</Link>.</p>
      </div>

      <SectionTitle>Organisation modules</SectionTitle>
      <div className="card p-4 mb-3">
        <p className="text-sm mb-3">The institution-wide modules below are currently open to <span className="font-medium">organisation administrators</span> (and the platform super-admin). Regular staff and external collaborators cannot open them.</p>
        <div className="space-y-2">
          {MODULES.map(([name, href, desc]) => (
            <div key={href} className="flex items-start justify-between gap-3 py-1.5 border-t" style={{ borderColor: "var(--border)" }}>
              <div><span className="font-medium">{name}</span><div className="text-xs" style={{ color: "var(--muted)" }}>{desc}</div></div>
              <Badge tone="muted">Org admin</Badge>
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs mb-6" style={{ color: "var(--muted)" }}>
        Note: HR, Finance and Procurement are not yet separate access tiers — anyone who is an organisation admin can open all three.
        If you want a dedicated HR officer, finance officer or procurement officer who only sees their own module, that finer-grained
        role separation can be added as a focused next step.
      </p>

      <SectionTitle>Project roles</SectionTitle>
      <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>Inside a project, what a person can do is set by their role on that project. Each role grants a fixed set of capabilities:</p>
      <div className="space-y-2 mb-6">
        {PROJECT_ROLES.map((role) => (
          <div key={role} className="card p-4">
            <div className="flex items-center justify-between gap-3 mb-1">
              <div className="font-medium">{ROLE_LABEL[role]}</div>
              <code className="text-xs" style={{ color: "var(--muted)" }}>{role}</code>
            </div>
            <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>{ROLE_NOTE[role]}</p>
            <div className="flex flex-wrap gap-1">
              {PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role].includes(p)).map((p) => (
                <Badge key={p} tone="ok">{PERM_LABEL[p]}</Badge>
              ))}
            </div>
          </div>
        ))}
      </div>

      <SectionTitle>Self-service &amp; collaborators</SectionTitle>
      <div className="card p-4 space-y-3">
        <div>
          <div className="font-medium">Staff self-service portal</div>
          <p className="text-sm" style={{ color: "var(--muted)" }}>Employees with a login get a limited portal: fill timesheets, request leave, raise purchase requests, manage their own profile, photo, signature and documents, and view the projects they are staffed on (Overview, SOW, Work plan, Gantt and Objectives only — never budgets or requisitions).</p>
        </div>
        <div className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <div className="font-medium">External collaborators</div>
          <p className="text-sm" style={{ color: "var(--muted)" }}>Partner-organisation logins get strictly read-only access, and only to the specific projects they are linked to.</p>
        </div>
        <div className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <div className="font-medium">Employee HR records</div>
          <p className="text-sm" style={{ color: "var(--muted)" }}>Full employee records (salary, bank details, statutory numbers, documents) are visible to organisation admins (HR) only. A Principal Investigator sees the role and responsibilities of staff on their own project via the project Team page, but not the sensitive HR record.</p>
        </div>
      </div>
    </div>
  );
}
