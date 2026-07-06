// Single source of truth for the string-typed statuses used across the schema.

export const SYSTEM_ROLES = ["super_admin", "org_admin", "support_admin"] as const;
export const PROJECT_ROLES = [
  "pi", "co_pi", "project_manager", "finance_admin", "coordinator",
  "statistician", "data_manager", "research_assistant", "data_clerk", "consultant",
  "assistant", "member", "reviewer", "approver", "viewer",
] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PROJECT_STATUS = ["draft", "active", "on_hold", "completed", "archived"] as const;

export const ACTIVITY_STATUS = [
  "not_started", "in_progress", "blocked", "done", "cancelled",
] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUS)[number];

export const REQ_STATUS = [
  "draft", "submitted", "finance_review", "pm_approval", "admin_approval",
  "approved", "partially_funded", "rejected", "disbursed", "retired", "closed",
] as const;
export type ReqStatus = (typeof REQ_STATUS)[number];

export const ANOMALY_RULES = [
  "over_budget", "wrong_line", "out_of_period", "negative_balance",
  "budget_decrease", "high_unit_cost", "missing_approval",
  "exceeds_available", "duplicate_ref",
] as const;
export type AnomalyRule = (typeof ANOMALY_RULES)[number];

export const PERMISSIONS = [
  "project.view", "project.comment", "project.edit", "project.administer",
  "members.manage", "budget.manage", "documents.manage", "reports.manage",
  "requisitions.create", "requisitions.approve", "requisitions.sign", "approvals.approve",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<ProjectRole, Permission[]> = {
  pi: PERMISSIONS.filter((p) => p !== "requisitions.create"),  // PIs approve/sign but do NOT initiate requisitions (segregation of duties)
  co_pi: PERMISSIONS.filter((p) => p !== "requisitions.create"),  // Co-PIs / Co-Investigators carry the same authority as the PI
  project_manager: [...PERMISSIONS],
  finance_admin: [
    "project.view", "project.comment", "budget.manage", "reports.manage",
    "requisitions.create", "requisitions.approve", "requisitions.sign", "approvals.approve",
  ],
  coordinator: [
    "project.view", "project.comment", "project.edit",
    "documents.manage", "reports.manage", "requisitions.create",
  ],
  statistician: ["project.view", "project.comment", "project.edit", "reports.manage"],
  data_manager: ["project.view", "project.comment", "project.edit", "documents.manage"],
  research_assistant: ["project.view", "project.comment", "project.edit"],
  data_clerk: ["project.view", "project.comment", "project.edit"],
  consultant: ["project.view", "project.comment"],
  assistant: ["project.view", "project.comment", "project.edit"],
  member: ["project.view", "project.comment"],
  reviewer: ["project.view", "project.comment", "approvals.approve"],
  approver: ["project.view", "requisitions.approve", "approvals.approve", "requisitions.sign"],
  viewer: ["project.view"],
};

export const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "info" | "muted"> = {
  // activities
  not_started: "muted", in_progress: "info", blocked: "danger", done: "ok", cancelled: "muted",
  // projects
  draft: "muted", setup: "muted", active: "ok", on_hold: "warn", completed: "info", closed: "info", archived: "muted",
  // requisitions
  submitted: "info", finance_review: "info", pm_approval: "info",
  admin_approval: "info", approved: "ok", partially_funded: "warn", rejected: "danger",
  disbursed: "ok", retired: "ok",
  // refunds
  pi_approved: "info", paid: "ok", acknowledged: "ok",
  // anomaly / generic
  info: "info", warning: "warn", critical: "danger", open: "warn", mitigating: "info",
};

const LABEL_OVERRIDES: Record<string, string> = {
  pi: "PI",
  co_pi: "Co-PI / Co-I",
};
export function label(s: string): string {
  if (LABEL_OVERRIDES[s]) return LABEL_OVERRIDES[s];
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
