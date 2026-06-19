import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";

export async function requireStudiesOrg(): Promise<{ orgId: string; orgName: string; userId: string; userName: string; isOrgAdmin: boolean; isSuperAdmin: boolean }> {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  return { orgId: org.id, orgName: org.name, userId: user.id, userName: user.name, isOrgAdmin: !!org.isOrgAdmin, isSuperAdmin: !!user.isSuperAdmin };
}
