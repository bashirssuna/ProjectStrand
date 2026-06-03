import { q } from "@/server/db";
import { id } from "@/lib/ids";
import type { AnomalyRule } from "@/lib/enums";

type Flag = { rule: AnomalyRule; severity: "info" | "warning" | "critical"; message: string; entity?: string };

// Re-evaluates all rules for a project. Auto-generated unresolved flags are
// rebuilt each run; resolved flags are kept for history.
export async function evaluateProject(projectId: string): Promise<number> {
  const flags: Flag[] = [];

  const proj = (await q<{ start_date: string | null; end_date: string | null; currency: string }>(
    `SELECT start_date, end_date, currency FROM project WHERE id = $1`, [projectId]
  ))[0];
  const start = proj?.start_date ? new Date(proj.start_date) : null;
  const end = proj?.end_date ? new Date(proj.end_date) : null;

  const lines = await q<{
    id: string; code: string; planned: number; unit_cost: number;
    category_id: string | null; committed: number; actual: number;
  }>(
    `SELECT bl.id, bl.code, bl.planned, bl.unit_cost, bl.category_id,
       COALESCE((SELECT SUM(amount) FROM commitment WHERE budget_line_id=bl.id),0) AS committed,
       COALESCE((SELECT SUM(amount) FROM expenditure WHERE budget_line_id=bl.id),0) AS actual
     FROM budget_line bl
     JOIN budget b ON b.id = bl.budget_id
     WHERE b.project_id = $1`,
    [projectId]
  );

  // category averages for unit-cost outlier detection
  const catAvg = new Map<string, number[]>();
  for (const l of lines) {
    const key = l.category_id ?? "_";
    if (!catAvg.has(key)) catAvg.set(key, []);
    catAvg.get(key)!.push(l.unit_cost);
  }

  for (const l of lines) {
    if (l.actual > l.planned) {
      flags.push({ rule: "over_budget", severity: "critical",
        message: `Line ${l.code} is over budget: spent exceeds planned by ${(l.actual - l.planned).toFixed(0)}.`,
        entity: `budget_line:${l.id}` });
    }
    const remaining = l.planned - l.committed - l.actual;
    if (remaining < 0) {
      flags.push({ rule: "negative_balance", severity: "critical",
        message: `Line ${l.code} has a negative balance of ${remaining.toFixed(0)}.`,
        entity: `budget_line:${l.id}` });
    }
    if (l.planned < l.committed) {
      flags.push({ rule: "budget_decrease", severity: "warning",
        message: `Line ${l.code} planned amount is below existing commitments.`,
        entity: `budget_line:${l.id}` });
    }
    const peers = (catAvg.get(l.category_id ?? "_") ?? []).filter((v) => v > 0);
    const avg = peers.length ? peers.reduce((a, b) => a + b, 0) / peers.length : 0;
    if (avg > 0 && l.unit_cost > avg * 3 && peers.length > 2) {
      flags.push({ rule: "high_unit_cost", severity: "info",
        message: `Line ${l.code} unit cost is unusually high vs others in its category.`,
        entity: `budget_line:${l.id}` });
    }
  }

  // Expenditure-level checks
  const exps = await q<{
    id: string; date: string; reference: string | null; approved: boolean;
    budget_line_id: string; requisition_id: string | null; req_line: string | null;
  }>(
    `SELECT e.id, e.date, e.reference, e.approved, e.budget_line_id,
            e.requisition_id, r.budget_line_id AS req_line
     FROM expenditure e
     LEFT JOIN requisition r ON r.id = e.requisition_id
     WHERE e.project_id = $1`,
    [projectId]
  );
  const seenRef = new Map<string, number>();
  for (const e of exps) {
    const d = new Date(e.date);
    if ((start && d < start) || (end && d > end)) {
      flags.push({ rule: "out_of_period", severity: "warning",
        message: `An expenditure is dated outside the project period.`, entity: `expenditure:${e.id}` });
    }
    if (e.requisition_id && e.req_line && e.req_line !== e.budget_line_id) {
      flags.push({ rule: "wrong_line", severity: "warning",
        message: `Expenditure posted to a different budget line than its requisition.`, entity: `expenditure:${e.id}` });
    }
    if (!e.approved) {
      flags.push({ rule: "missing_approval", severity: "warning",
        message: `An expenditure was recorded without an approval.`, entity: `expenditure:${e.id}` });
    }
    if (e.reference) {
      seenRef.set(e.reference, (seenRef.get(e.reference) ?? 0) + 1);
    }
  }
  for (const [ref, count] of seenRef) {
    if (count > 1) {
      flags.push({ rule: "duplicate_ref", severity: "warning",
        message: `Reference "${ref}" appears on ${count} expenditures.` });
    }
  }

  // Requisition vs available funds
  const reqs = await q<{ id: string; number: string; amount: number; available: number }>(
    `SELECT r.id, r.number, r.amount,
       (bl.planned
         - COALESCE((SELECT SUM(amount) FROM commitment WHERE budget_line_id=bl.id),0)
         - COALESCE((SELECT SUM(amount) FROM expenditure WHERE budget_line_id=bl.id),0)) AS available
     FROM requisition r JOIN budget_line bl ON bl.id = r.budget_line_id
     WHERE r.project_id = $1 AND r.status NOT IN ('rejected','closed','draft')`,
    [projectId]
  );
  for (const r of reqs) {
    if (r.amount > r.available) {
      flags.push({ rule: "exceeds_available", severity: "critical",
        message: `Requisition ${r.number} requests more than the available balance on its budget line.`,
        entity: `requisition:${r.id}` });
    }
  }

  await q(`DELETE FROM anomaly_flag WHERE project_id = $1 AND resolved = false`, [projectId]);
  for (const f of flags) {
    await q(
      `INSERT INTO anomaly_flag (id, project_id, rule, severity, message, entity)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id("anm"), projectId, f.rule, f.severity, f.message, f.entity ?? null]
    );
  }
  return flags.length;
}
