import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { isModuleEnabled } from "@/server/modules";

export async function requireStudiesOrg(): Promise<{ orgId: string; orgName: string; userId: string; userName: string; isOrgAdmin: boolean; isSuperAdmin: boolean }> {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  if (!(await isModuleEnabled(org.id, "research"))) redirect("/dashboard?module=off");
  return { orgId: org.id, orgName: org.name, userId: user.id, userName: user.name, isOrgAdmin: !!org.isOrgAdmin, isSuperAdmin: !!user.isSuperAdmin };
}
