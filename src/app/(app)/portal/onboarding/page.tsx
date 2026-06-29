import Link from "next/link";
import { requirePortalEmployee } from "../_guard";
import { listInstancesForEmployee } from "@/server/services/checklists";
import { PageHeader, StatusBadge, Badge, Empty, ProgressBar } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";

const typeTone = (t: string) => (t === "onboarding" ? "ok" : t === "exit" ? "warn" : "info");

export default async function PortalOnboardingPage() {
  const { orgId, employeeId, name } = await requirePortalEmployee();
  const rows = await listInstancesForEmployee(orgId, employeeId);

  return (
    <div className="max-w-2xl">
      <PageHeader title="My onboarding & exit" subtitle={`Checklists for ${name}`} actions={<Link href="/portal" className="btn btn-sm">← Portal</Link>} />
      {rows.length === 0 ? <Empty title="Nothing assigned" hint="Your induction or exit checklist will appear here when HR starts one." /> : (
        <div className="space-y-2">
          {rows.map((c) => (
            <Link key={c.id} href={`/portal/onboarding/${c.id}`} className="card p-3 block hover:opacity-90">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-sm">{c.title}</div>
                <div className="flex items-center gap-2"><Badge tone={typeTone(c.type)}>{label(c.type)}</Badge><StatusBadge status={c.status} /></div>
              </div>
              <div className="flex items-center gap-2 mt-2"><ProgressBar value={c.total ? Math.round((c.done / c.total) * 100) : 0} /><span className="text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>{c.done}/{c.total}</span></div>
              {c.dueDate && <div className="text-xs mt-1" style={{ color: c.overdue ? "var(--danger)" : "var(--muted)" }}>Due {fmtDate(c.dueDate)}{c.overdue ? " · overdue" : ""}</div>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
