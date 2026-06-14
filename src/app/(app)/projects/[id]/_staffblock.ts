import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";

// Restricted logins — staff (self-service employees) and external collaborators
// — must not reach budget, spending, requisitions, documents, team, reports,
// risks, approvals, audit, import, or calendar pages even by typing the URL.
// Both are limited to Overview / SOW / Work plan / Gantt / Objectives. Called at
// the top of each restricted project page, so this one check protects them all.
export async function blockStaff(projectId: string) {
  const user = await requireUser();
  if (user.isStaff || user.isCollaborator) redirect(`/projects/${projectId}`);
}
