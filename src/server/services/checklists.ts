import "server-only";
import { q, one } from "@/server/db";

export const CHECKLIST_TYPES = ["onboarding", "exit", "handover"] as const;
export const ASSIGNEE_ROLES = ["HR", "Line Manager", "Employee", "IT", "Finance", "Procurement", "Stores", "Administration"] as const;
export const ITEM_STATUSES = ["pending", "done", "na"] as const;

// ---- Templates ----
export type TemplateRow = { id: string; type: string; name: string; description: string | null; active: boolean; items: number };
export async function listTemplates(orgId: string, type?: string): Promise<TemplateRow[]> {
  const where = ["t.org_id=$1"]; const params: unknown[] = [orgId];
  if (type) { where.push("t.type=$2"); params.push(type); }
  return q<TemplateRow>(
    `SELECT t.id, t.type, t.name, t.description, t.active,
            (SELECT COUNT(*) FROM checklist_template_item i WHERE i.template_id=t.id)::int AS items
     FROM checklist_template t WHERE ${where.join(" AND ")} ORDER BY t.type, t.name`, params);
}
export async function getTemplate(orgId: string, id: string) {
  return one<{ id: string; type: string; name: string; description: string | null; active: boolean }>(
    `SELECT id, type, name, description, active FROM checklist_template WHERE id=$1 AND org_id=$2`, [id, orgId]);
}
export type TemplateItem = { id: string; category: string | null; title: string; description: string | null; assigneeRole: string | null; sortOrder: number };
export async function listTemplateItems(orgId: string, templateId: string): Promise<TemplateItem[]> {
  return q<TemplateItem>(
    `SELECT id, category, title, description, assignee_role AS "assigneeRole", sort_order AS "sortOrder"
     FROM checklist_template_item WHERE template_id=$1 AND org_id=$2 ORDER BY sort_order, created_at`, [templateId, orgId]);
}

// ---- Instances ----
export type InstanceRow = {
  id: string; type: string; title: string; status: string; employeeId: string | null; employeeName: string | null;
  startedDate: string | null; dueDate: string | null; completedDate: string | null; total: number; done: number; overdue: boolean;
};
export async function listInstances(orgId: string, f: { type?: string; status?: string; employeeId?: string } = {}): Promise<InstanceRow[]> {
  const where = ["c.org_id=$1"]; const params: unknown[] = [orgId]; let n = 2;
  if (f.type) { where.push(`c.type=$${n}`); params.push(f.type); n++; }
  if (f.status === "open") where.push(`c.status='open'`);
  else if (f.status === "completed") where.push(`c.status='completed'`);
  if (f.employeeId) { where.push(`c.employee_id=$${n}`); params.push(f.employeeId); n++; }
  return q<InstanceRow>(
    `SELECT c.id, c.type, c.title, c.status, c.employee_id AS "employeeId",
            (e.first_name || ' ' || e.last_name) AS "employeeName",
            c.started_date AS "startedDate", c.due_date AS "dueDate", c.completed_date AS "completedDate",
            (SELECT COUNT(*) FROM checklist_instance_item i WHERE i.instance_id=c.id)::int AS total,
            (SELECT COUNT(*) FROM checklist_instance_item i WHERE i.instance_id=c.id AND i.status IN ('done','na'))::int AS done,
            (c.status='open' AND c.due_date IS NOT NULL AND c.due_date < CURRENT_DATE) AS overdue
     FROM checklist_instance c LEFT JOIN employee e ON e.id=c.employee_id
     WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC LIMIT 500`, params);
}

export async function checklistStats(orgId: string): Promise<{ onboardingOpen: number; exitOpen: number; overdue: number; completed: number }> {
  const r = await one<{ onboardingOpen: number; exitOpen: number; overdue: number; completed: number }>(
    `SELECT COUNT(*) FILTER (WHERE type='onboarding' AND status='open')::int "onboardingOpen",
            COUNT(*) FILTER (WHERE type IN ('exit','handover') AND status='open')::int "exitOpen",
            COUNT(*) FILTER (WHERE status='open' AND due_date IS NOT NULL AND due_date < CURRENT_DATE)::int overdue,
            COUNT(*) FILTER (WHERE status='completed')::int completed
     FROM checklist_instance WHERE org_id=$1`, [orgId]);
  return { onboardingOpen: r?.onboardingOpen ?? 0, exitOpen: r?.exitOpen ?? 0, overdue: r?.overdue ?? 0, completed: r?.completed ?? 0 };
}

export type InstanceDetail = {
  id: string; type: string; title: string; status: string; employeeId: string | null; employeeName: string | null;
  startedDate: string | null; dueDate: string | null; completedDate: string | null; notes: string | null;
};
export async function getInstance(orgId: string, id: string): Promise<InstanceDetail | null> {
  return one<InstanceDetail>(
    `SELECT c.id, c.type, c.title, c.status, c.employee_id AS "employeeId",
            (e.first_name || ' ' || e.last_name) AS "employeeName",
            c.started_date AS "startedDate", c.due_date AS "dueDate", c.completed_date AS "completedDate", c.notes
     FROM checklist_instance c LEFT JOIN employee e ON e.id=c.employee_id WHERE c.id=$1 AND c.org_id=$2`, [id, orgId]);
}
export type InstanceItem = {
  id: string; category: string | null; title: string; description: string | null; assignee: string | null;
  status: string; doneBy: string | null; doneAt: string | null; dueDate: string | null; notes: string | null;
};
export async function listInstanceItems(orgId: string, instanceId: string): Promise<InstanceItem[]> {
  return q<InstanceItem>(
    `SELECT id, category, title, description, assignee, status, done_by AS "doneBy", done_at AS "doneAt", due_date AS "dueDate", notes
     FROM checklist_instance_item WHERE instance_id=$1 AND org_id=$2 ORDER BY sort_order, created_at`, [instanceId, orgId]);
}
export function instanceProgress(items: { status: string }[]): number {
  if (!items.length) return 0;
  const done = items.filter((i) => i.status === "done" || i.status === "na").length;
  return Math.round((done / items.length) * 100);
}

// Instances for a given employee (portal view).
export async function listInstancesForEmployee(orgId: string, employeeId: string): Promise<InstanceRow[]> {
  return listInstances(orgId, { employeeId });
}
