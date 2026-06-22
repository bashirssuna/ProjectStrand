import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { isModuleEnabled } from "@/server/modules";
export async function requireCollabOrg(): Promise<{ orgId: string; orgName: string }> {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  if (!(await isModuleEnabled(org.id, "collaborations"))) redirect("/dashboard?module=off");
  if (!org.isOrgAdmin && !user.isSuperAdmin) redirect("/dashboard");
  return { orgId: org.id, orgName: org.name };
}
