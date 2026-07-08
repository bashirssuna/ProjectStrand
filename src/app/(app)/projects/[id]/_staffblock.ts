import { redirect } from "next/navigation";
import { getProjectAccess } from "@/server/policy";

// Restricted logins — staff (self-service employees) and external collaborators
// — must not reach budget, spending, requisitions, documents, team, reports,
// risks, approvals, audit, import, or calendar pages even by typing the URL.
// Both are limited to Overview / SOW / Work plan / Gantt / Objectives. Called at
// the top of each restricted project page, so this one check protects them all.
// EXCEPTION: staff from the institutional support departments (Finance /
// Accounts / Administration / HR) carry finance-admin rights across their
// organisation's projects (see getProjectAccess) and are not restricted.
export async function blockStaff(projectId: string) {
  const access = await getProjectAccess(projectId);
  const restricted = (access.user.isStaff && !access.deptFinance) || access.user.isCollaborator;
  if (restricted) redirect(`/projects/${projectId}`);
}
