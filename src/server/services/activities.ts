import "server-only";
import { q } from "@/server/db";

// Rolls child progress up into parent activities, bottom-up. A parent's
// progress becomes the rounded average of its children; done children pull it
// toward 100, not-started toward 0 — so parent/overall % tracks completion
// automatically. Leaf activities keep their own (manually set) progress.
export async function recomputeRollups(projectId: string): Promise<void> {
  const acts = await q<{ id: string; parentId: string | null; progress: number; status: string; type: string }>(
    `SELECT id, parent_id AS "parentId", progress, status, type FROM activity WHERE project_id=$1`, [projectId]
  );
  const childrenOf = new Map<string, typeof acts>();
  for (const a of acts) {
    if (a.parentId) {
      if (!childrenOf.has(a.parentId)) childrenOf.set(a.parentId, []);
      childrenOf.get(a.parentId)!.push(a);
    }
  }
  const byId = new Map(acts.map((a) => [a.id, a]));

  // memoised post-order computation
  const computed = new Map<string, number>();
  const compute = (id: string): number => {
    if (computed.has(id)) return computed.get(id)!;
    const kids = childrenOf.get(id) ?? [];
    const self = byId.get(id)!;
    let value: number;
    if (kids.length === 0) {
      value = self.status === "done" ? 100 : self.status === "not_started" ? 0 : self.progress;
    } else {
      value = Math.round(kids.reduce((s, k) => s + compute(k.id), 0) / kids.length);
    }
    computed.set(id, value);
    return value;
  };
  for (const a of acts) compute(a.id);

  // persist parents whose computed value changed
  for (const a of acts) {
    const kids = childrenOf.get(a.id) ?? [];
    if (kids.length === 0) continue;
    const v = computed.get(a.id)!;
    if (v !== a.progress) {
      await q(`UPDATE activity SET progress=$2, updated_at=now() WHERE id=$1`, [a.id, v]);
    }
  }
}
