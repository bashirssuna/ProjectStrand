import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHrOrg } from "../../../_guard";
import { getTemplate, listTemplateItems, ASSIGNEE_ROLES } from "@/server/services/checklists";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { label } from "@/lib/enums";
import { addTemplateItemAction, deleteTemplateItemAction, deleteChecklistTemplateAction } from "@/app/actions";

export default async function TemplateEditor({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId } = await requireHrOrg();
  const { id } = await params;
  const sp = await searchParams;
  const tpl = await getTemplate(orgId, id);
  if (!tpl) notFound();
  const items = await listTemplateItems(orgId, id);
  // group by category, preserving order
  const groups: { category: string; items: typeof items }[] = [];
  for (const it of items) {
    const cat = it.category || "General";
    let g = groups.find((x) => x.category === cat);
    if (!g) { g = { category: cat, items: [] }; groups.push(g); }
    g.items.push(it);
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title={tpl.name} subtitle={`${label(tpl.type)} template · ${items.length} items`} actions={<Link href="/hr/checklists" className="btn btn-sm">← Checklists</Link>} />
      {sp.err === "title" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>An item title is required.</div>}
      {tpl.description && <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>{tpl.description}</p>}

      <SectionTitle>Checklist items</SectionTitle>
      <div className="mt-2 mb-5 space-y-4">
        {items.length === 0 ? <Empty title="No items yet" hint="Add the tasks that make up this checklist." /> : groups.map((g) => (
          <div key={g.category}>
            <div className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>{g.category}</div>
            <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
              {g.items.map((it) => (
                <div key={it.id} className="p-3 flex items-start justify-between gap-3">
                  <div><div className="text-sm font-medium">{it.title}</div>{it.description && <div className="text-xs" style={{ color: "var(--muted)" }}>{it.description}</div>}</div>
                  <div className="flex items-center gap-2 shrink-0">
                    {it.assigneeRole && <Badge tone="muted">{it.assigneeRole}</Badge>}
                    <form action={deleteTemplateItemAction}><input type="hidden" name="itemId" value={it.id} /><input type="hidden" name="templateId" value={tpl.id} /><button className="btn btn-sm" type="submit" title="Remove">✕</button></form>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="card p-4 mb-5">
        <SectionTitle>Add item</SectionTitle>
        <form action={addTemplateItemAction} className="grid sm:grid-cols-2 gap-3 mt-2">
          <input type="hidden" name="templateId" value={tpl.id} />
          <Field label="Category / phase"><input name="category" className="input" placeholder="e.g. First day, IT, Finance" /></Field>
          <Field label="Assignee role"><select name="assigneeRole" className="select"><option value="">—</option>{ASSIGNEE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
          <div className="sm:col-span-2"><Field label="Task *"><input name="title" required className="input" placeholder="e.g. Issue ID card and office access" /></Field></div>
          <div className="sm:col-span-2"><Field label="Description / notes"><input name="description" className="input" /></Field></div>
          <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Add item</button></div>
        </form>
      </div>

      <form action={deleteChecklistTemplateAction}>
        <input type="hidden" name="templateId" value={tpl.id} />
        <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete template</button>
      </form>
    </div>
  );
}
