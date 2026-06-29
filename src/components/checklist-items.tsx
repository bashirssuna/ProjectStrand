import { toggleChecklistItemAction } from "@/app/actions";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { Badge } from "@/components/ui";
import { label } from "@/lib/enums";
import type { InstanceItem } from "@/server/services/checklists";

const statusTone = (s: string) => (s === "done" ? "ok" : s === "na" ? "muted" : "warn");

// Renders checklist items grouped by category, each with a status/notes update form.
// Used by both the HR instance page and the portal view (pass returnTo="portal").
export function ChecklistItems({ items, instanceId, returnTo, locked }: { items: InstanceItem[]; instanceId: string; returnTo?: "portal"; locked?: boolean }) {
  const groups: { category: string; items: InstanceItem[] }[] = [];
  for (const it of items) {
    const cat = it.category || "General";
    let g = groups.find((x) => x.category === cat);
    if (!g) { g = { category: cat, items: [] }; groups.push(g); }
    g.items.push(it);
  }
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.category}>
          <div className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>{g.category}</div>
          <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
            {g.items.map((it) => (
              <div key={it.id} className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{it.title}</div>
                    {it.description && <div className="text-xs" style={{ color: "var(--muted)" }}>{it.description}</div>}
                    <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                      {it.assignee && <span>{it.assignee}</span>}
                      {it.dueDate && <span>{it.assignee ? " · " : ""}due {fmtDate(it.dueDate)}</span>}
                      {it.doneBy && it.doneAt && <span> · {it.status === "na" ? "marked N/A" : "done"} by {it.doneBy} {fmtDateTime(it.doneAt)}</span>}
                    </div>
                    {it.notes && <div className="text-xs mt-0.5">📝 {it.notes}</div>}
                  </div>
                  <Badge tone={statusTone(it.status)}>{it.status === "na" ? "N/A" : label(it.status)}</Badge>
                </div>
                {!locked && (
                  <form action={toggleChecklistItemAction} className="flex flex-wrap items-end gap-2 mt-2 no-print">
                    <input type="hidden" name="itemId" value={it.id} /><input type="hidden" name="instanceId" value={instanceId} />
                    {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
                    <select name="status" defaultValue={it.status} className="select select-sm"><option value="pending">Pending</option><option value="done">Done</option><option value="na">N/A</option></select>
                    <input name="notes" defaultValue={it.notes ?? ""} className="input input-sm" placeholder="Notes" style={{ minWidth: 160 }} />
                    <button className="btn btn-sm" type="submit">Update</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
