import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";

// The laboratory is open to any member of the organisation (researchers and lab
// assistants need it, not only admins). PII visibility and destructive actions are
// gated inside the pages via isOrgAdmin / isSuperAdmin.
export async function requireLabOrg(): Promise<{ orgId: string; orgName: string; userId: string; userName: string; isOrgAdmin: boolean; isSuperAdmin: boolean }> {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  return { orgId: org.id, orgName: org.name, userId: user.id, userName: user.name, isOrgAdmin: !!org.isOrgAdmin, isSuperAdmin: !!user.isSuperAdmin };
}
