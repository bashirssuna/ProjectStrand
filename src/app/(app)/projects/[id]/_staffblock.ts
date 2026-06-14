import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";

// Staff (self-service) logins must not reach budget, spending, requisitions,
// documents, team, reports, risks, approvals, audit, import, or calendar pages
// even by typing the URL. Call at the top of each restricted project page.
export async function blockStaff(projectId: string) {
  const user = await requireUser();
  if (user.isStaff) redirect(`/projects/${projectId}`);
}
