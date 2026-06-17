import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";

// Standard cost categories modelled on common donor budget templates
// (e.g. ARNTD SGP). Rendered as the budget's sections, in this order.
export const STANDARD_BUDGET_CATEGORIES: { name: string; costType: "direct" | "indirect" }[] = [
  { name: "Personnel / Per Diem", costType: "direct" },
  { name: "Travel & Transportation", costType: "direct" },
  { name: "Logistics, Supplies & Consumables", costType: "direct" },
  { name: "Equipment", costType: "direct" },
  { name: "Communication", costType: "direct" },
  { name: "Other Direct Costs", costType: "direct" },
  { name: "Indirect Costs", costType: "indirect" },
];

// Idempotently create any missing standard sections on a budget.
export async function ensureStandardCategories(budgetId: string): Promise<void> {
  const existing = await q<{ name: string }>(`SELECT name FROM budget_category WHERE budget_id=$1`, [budgetId]);
  const have = new Set(existing.map((e) => e.name.toLowerCase()));
  for (const cat of STANDARD_BUDGET_CATEGORIES) {
    if (!have.has(cat.name.toLowerCase())) {
      await q(`INSERT INTO budget_category (id, budget_id, name, cost_type) VALUES ($1,$2,$3,$4)`, [id("bcat"), budgetId, cat.name, cat.costType]);
    }
  }
}

export type LineRollup = {
  id: string; code: string; description: string; categoryName: string | null; categoryId: string | null;
  costType: string; activityArea: string | null; justification: string | null;
  unit: string; unitCost: number; quantity: number; frequency: number;
  planned: number; committed: number; actual: number; remaining: number; burn: number;
};

export async function budgetLineRollups(budgetId: string): Promise<LineRollup[]> {
  const lines = await q<LineRollup & { categoryName: string | null }>(
    `SELECT bl.id, bl.code, bl.description,
            COALESCE(c.cost_type, 'direct') AS "costType",
            bl.activity_area AS "activityArea", bl.unit, bl.justification,
            bl.unit_cost AS "unitCost", bl.quantity, COALESCE(bl.frequency,1) AS frequency, bl.planned,
            c.name AS "categoryName", bl.category_id AS "categoryId",
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
