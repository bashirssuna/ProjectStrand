import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHrOrg } from "../../_guard";
import { getInstance, listInstanceItems, instanceProgress } from "@/server/services/checklists";
import { PageHeader, SectionTitle, Field, StatusBadge, Badge, Empty, ProgressBar } from "@/components/ui";
import { ChecklistItems } from "@/components/checklist-items";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { addInstanceItemAction, completeChecklistAction, reopenChecklistAction, deleteChecklistInstanceAction } from "@/app/actions";

const typeTone = (t: string) => (t === "onboarding" ? "ok" : t === "exit" ? "warn" : "info");

export default async function ChecklistInstancePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId } = await requireHrOrg();
  const { id } = await params;
  const sp = await searchParams;
  const inst = await getInstance(orgId, id);
  if (!inst) notFound();
  const items = await listInstanceItems(orgId, id);
  const progress = instanceProgress(items);
  const locked = inst.status === "completed";

  return (
    <div className="max-w-3xl">
      <PageHeader title={inst.title} subtitle={`${label(inst.type)}${inst.employeeName ? ` · ${inst.employeeName}` : ""}`} actions={<Link href="/hr/checklists" className="btn btn-sm">← Checklists</Link>} />
      {sp.err === "title" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>An item title is required.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <StatusBadge status={inst.status} />
        <Badge tone={typeTone(inst.type)}>{label(inst.type)}</Badge>
        {inst.dueDate && <span className="text-sm" style={{ color: "var(--muted)" }}>Due {fmtDate(inst.dueDate)}</span>}
        {inst.completedDate && <span className="text-sm" style={{ color: "var(--ok)" }}>Completed {fmtDate(inst.completedDate)}</span>}
        <div className="ml-auto flex items-center gap-2">
          {!locked
            ? <form action={completeChecklistAction}><input type="hidden" name="instanceId" value={inst.id} /><button className="btn btn-sm btn-primary" type="submit">Mark complete</button></form>
            : <form action={reopenChecklistAction}><input type="hidden" name="instanceId" value={inst.id} /><button className="btn btn-sm" type="submit">Reopen</button></form>}
          <form action={deleteChecklistInstanceAction}><input type="hidden" name="instanceId" value={inst.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete</button></form>
        </div>
      </div>

      <div className="card p-4 mb-5">
        <div className="flex items-center justify-between mb-1 text-sm"><span className="font-medium">Progress</span><span style={{ color: "var(--muted)" }}>{items.filter((i) => i.status !== "pending").length}/{items.length} actioned · {progress}%</span></div>
        <ProgressBar value={progress} />
      </div>

      <SectionTitle>Items</SectionTitle>
      <div className="mt-2 mb-5">
        {items.length === 0 ? <Empty title="No items" hint="Add checklist items below." /> : <ChecklistItems items={items} instanceId={inst.id} locked={locked} />}
      </div>

      {!locked && (
        <div className="card p-4">
          <SectionTitle>Add item</SectionTitle>
          <form action={addInstanceItemAction} className="grid sm:grid-cols-2 gap-3 mt-2">
            <input type="hidden" name="instanceId" value={inst.id} />
            <Field label="Category"><input name="category" className="input" placeholder="e.g. IT, Finance" /></Field>
            <Field label="Assignee"><input name="assignee" className="input" placeholder="Person / unit" /></Field>
            <div className="sm:col-span-2"><Field label="Task *"><input name="title" required className="input" /></Field></div>
            <Field label="Due date"><input name="dueDate" type="date" className="input" /></Field>
            <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Add item</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
