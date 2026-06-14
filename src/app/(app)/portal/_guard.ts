import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { employeeForUser } from "@/server/services/hr";

// The portal is for staff logins (employees). Returns their employee record.
export async function requirePortalEmployee() {
  const user = await requireUser();
  const emp = await employeeForUser(user.id);
  if (!emp) redirect("/dashboard"); // not an employee login → normal app
  return { user, employeeId: emp.id, orgId: emp.orgId, name: `${emp.firstName} ${emp.lastName}` };
}
