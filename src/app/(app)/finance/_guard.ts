import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";

// Institution finance is for organisation admins (and platform super-admins).
export async function requireFinanceOrg(): Promise<{ orgId: string; orgName: string; userId: string; userName: string }> {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  if (!org.isOrgAdmin && !user.isSuperAdmin) redirect("/dashboard");
  return { orgId: org.id, orgName: org.name, userId: user.id, userName: user.name };
}
