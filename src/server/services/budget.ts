import "server-only";
import { q, one } from "@/server/db";

export type LineRollup = {
  id: string; code: string; description: string; categoryName: string | null;
  costType: string; activityArea: string | null;
  unit: string; unitCost: number; quantity: number;
  planned: number; committed: number; actual: number; remaining: number; burn: number;
};

export async function budgetLineRollups(budgetId: string): Promise<LineRollup[]> {
  const lines = await q<LineRollup & { categoryName: string | null }>(
    `SELECT bl.id, bl.code, bl.description,
            COALESCE(c.cost_type, 'direct') AS "costType",
            bl.activity_area AS "activityArea", bl.unit,
            bl.unit_cost AS "unitCost", bl.quantity, bl.planned,
            c.name AS "categoryName",
            COALESCE((SELECT SUM(amount) FROM commitment WHERE budget_line_id = bl.id), 0) AS committed,
            COALESCE((SELECT SUM(amount) FROM expenditure WHERE budget_line_id = bl.id), 0) AS actual
     FROM budget_line bl
     LEFT JOIN budget_category c ON c.id = bl.category_id
     WHERE bl.budget_id = $1
     ORDER BY bl.code`,
    [budgetId]
  );
  return lines.map((l) => {
    const remaining = l.planned - l.actual - l.committed;
    const burn = l.planned > 0 ? (l.actual / l.planned) * 100 : 0;
    return { ...l, remaining, burn, costType: l.costType ?? "direct" };
  });
}

export type BudgetSummary = {
  planned: number; committed: number; actual: number; remaining: number; burn: number;
};

export async function budgetSummary(budgetId: string): Promise<BudgetSummary> {
  const rollups = await budgetLineRollups(budgetId);
  const planned = rollups.reduce((s, r) => s + r.planned, 0);
  const committed = rollups.reduce((s, r) => s + r.committed, 0);
  const actual = rollups.reduce((s, r) => s + r.actual, 0);
  return {
    planned, committed, actual,
    remaining: planned - committed - actual,
    burn: planned > 0 ? (actual / planned) * 100 : 0,
  };
}

export async function lineAvailable(budgetLineId: string): Promise<number> {
  const row = await one<{ planned: number; committed: number; actual: number }>(
    `SELECT bl.planned,
            COALESCE((SELECT SUM(amount) FROM commitment WHERE budget_line_id = bl.id),0) AS committed,
            COALESCE((SELECT SUM(amount) FROM expenditure WHERE budget_line_id = bl.id),0) AS actual
     FROM budget_line bl WHERE bl.id = $1`,
    [budgetLineId]
  );
  if (!row) return 0;
  return row.planned - row.committed - row.actual;
}
