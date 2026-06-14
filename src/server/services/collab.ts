import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";

// ---------------------------------------------------------------------------
// Grant an external collaborator a restricted, view-only login and email them
// an invite (set-password) link. The account is flagged is_collaborator=true so
// the app shows them ONLY the projects they're linked to, and within each only
// the Overview / SOW / Work plan / Gantt / Objectives tabs. Mirrors the staff
// (employee) login flow and reuses the existing invite-token machinery.
// ---------------------------------------------------------------------------
export async function createCollaboratorLogin(collaboratorId: string): Promise<{ emailStatus: "sent" | "failed" | "exists"; emailError?: string }> {
  const c = await one<{ orgId: string; name: string; email: string | null; userId: string | null }>(
    `SELECT org_id AS "orgId", name, email, user_id AS "userId" FROM collaborator WHERE id=$1`, [collaboratorId]
  );
  if (!c) throw new Error("Collaborator not found.");
  if (c.userId) return { emailStatus: "exists" };
  if (!c.email) throw new Error("Add an email address to this collaborator before creating a login.");

  // Reuse an existing account with this email, or create one.
  let target = await one<{ id: string }>(`SELECT id FROM app_user WHERE email=$1`, [c.email]);
  if (!target) {
    const uid = id("usr");
    await q(`INSERT INTO app_user (id, email, name, status, is_collaborator) VALUES ($1,$2,$3,'invited',true)`,
      [uid, c.email, c.name]);
    await q(`INSERT INTO user_profile (id, user_id) VALUES ($1,$2)`, [id("up"), uid]);
    target = { id: uid };
  } else {
    await q(`UPDATE app_user SET is_collaborator=true WHERE id=$1`, [target.id]);
  }

  // Plain org membership so the org resolves for them (NOT org admin — they get
  // no institution-wide access; project visibility is gated separately).
  const memberRole = await one<{ id: string }>(`SELECT id FROM role WHERE org_id=$1 AND key='member' LIMIT 1`, [c.orgId]);
  if (memberRole) {
    await q(`INSERT INTO org_membership (id, org_id, user_id, role_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [id("om"), c.orgId, target.id, memberRole.id]);
  }
  await q(`UPDATE collaborator SET user_id=$2 WHERE id=$1`, [collaboratorId, target.id]);

  const { issuePasswordToken } = await import("@/server/services/accounts");
  const issued = await issuePasswordToken(target.id, "invite", c.email, c.name);
  return { emailStatus: issued.emailStatus, emailError: issued.emailError };
}
