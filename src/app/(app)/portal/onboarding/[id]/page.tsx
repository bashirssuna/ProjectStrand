import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePortalEmployee } from "../../_guard";
import { getInstance, listInstanceItems, instanceProgress } from "@/server/services/checklists";
import { PageHeader, SectionTitle, StatusBadge, Badge, Empty, ProgressBar } from "@/components/ui";
import { ChecklistItems } from "@/components/checklist-items";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";

const typeTone = (t: string) => (t === "onboarding" ? "ok" : t === "exit" ? "warn" : "info");

export default async function PortalChecklistDetail({ params }: { params: Promise<{ id: string }> }) {
  const { orgId, employeeId } = await requirePortalEmployee();
  const { id } = await params;
  const inst = await getInstance(orgId, id);
  if (!inst || inst.employeeId !== employeeId) redirect("/portal/onboarding");
  const items = await listInstanceItems(orgId, id);
  const progress = instanceProgress(items);
  const locked = inst.status === "completed";

  return (
    <div className="max-w-2xl">
      <PageHeader title={inst.title} subtitle={label(inst.type)} actions={<Link href="/portal/onboarding" className="btn btn-sm">← Back</Link>} />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <StatusBadge status={inst.status} />
        <Badge tone={typeTone(inst.type)}>{label(inst.type)}</Badge>
        {inst.dueDate && <span className="text-sm" style={{ color: "var(--muted)" }}>Due {fmtDate(inst.dueDate)}</span>}
      </div>

      <div className="card p-4 mb-5">
        <div className="flex items-center justify-between mb-1 text-sm"><span className="font-medium">Progress</span><span style={{ color: "var(--muted)" }}>{progress}%</span></div>
        <ProgressBar value={progress} />
      </div>

      <SectionTitle>Your tasks</SectionTitle>
      <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Tick items as you complete them. {locked && "This checklist is marked complete."}</p>
      <div className="mt-1">
        {items.length === 0 ? <Empty title="No items" hint="Nothing to action here yet." /> : <ChecklistItems items={items} instanceId={inst.id} returnTo="portal" locked={locked} />}
      </div>
    </div>
  );
}
