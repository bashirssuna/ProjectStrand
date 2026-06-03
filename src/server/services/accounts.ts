import "server-only";
import { randomBytes } from "node:crypto";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { sendEmail } from "@/server/email";
import { writeAudit, notify } from "@/server/services/audit";
import { hashPassword } from "@/lib/password";

const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000";

// Creates a single-use token and emails the recipient a link to set a password.
export async function issuePasswordToken(userId: string, purpose: "invite" | "reset", email: string, name: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString(); // 48h
  await q(`INSERT INTO password_token (id, user_id, token, purpose, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [id("pt"), userId, token, purpose, expires]);
  const link = `${APP_URL}/reset?token=${token}`;
  const intro = purpose === "invite"
    ? "An account has been created for you on Project Strand. Set your password to sign in:"
    : "We received a request to reset your password. Set a new one here:";
  await sendEmail({
    to: email,
    subject: purpose === "invite" ? "You've been invited to Project Strand" : "Reset your Project Strand password",
    html:
      `<p>Hi ${name || email},</p><p>${intro}</p>` +
      `<p><a href="${link}">${link}</a></p>` +
      `<p>This link expires in 48 hours. If you didn't expect this, you can ignore it.</p>`,
  });
  return token;
}

// Looks up and validates a password token.
export async function consumePasswordToken(token: string): Promise<{ userId: string; email: string } | null> {
  const row = await one<{ userId: string; email: string; expiresAt: string; used: boolean }>(
    `SELECT pt.user_id AS "userId", u.email, pt.expires_at AS "expiresAt", pt.used
     FROM password_token pt JOIN app_user u ON u.id = pt.user_id
     WHERE pt.token = $1`, [token]
  );
  if (!row || row.used || new Date(row.expiresAt) < new Date()) return null;
  return { userId: row.userId, email: row.email };
}

export async function markTokenUsed(token: string): Promise<void> {
  await q(`UPDATE password_token SET used = true WHERE token = $1`, [token]);
}

// Finds-or-creates a user by email and attaches them to a project with a role.
// New users are created in 'invited' status and emailed a set-password link.
export async function addProjectMemberByEmail(
  projectId: string, email: string, name: string, role: string, actorId: string
): Promise<void> {
  const org = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [projectId]);
  let target = await one<{ id: string; status: string }>(`SELECT id, status FROM app_user WHERE email=$1`, [email]);

  if (!target) {
    const uid = id("usr");
    const displayName = name || email.split("@")[0];
    await q(`INSERT INTO app_user (id, email, name, status) VALUES ($1,$2,$3,'invited')`, [uid, email, displayName]);
    await q(`INSERT INTO user_profile (id, user_id) VALUES ($1,$2)`, [id("up"), uid]);
    if (org) await q(`INSERT INTO org_membership (id, org_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id("om"), org.orgId, uid]);
    await issuePasswordToken(uid, "invite", email, displayName);
    target = { id: uid, status: "invited" };
  } else if (org) {
    await q(`INSERT INTO org_membership (id, org_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id("om"), org.orgId, target.id]);
  }

  await q(`INSERT INTO project_member (id, project_id, user_id, role) VALUES ($1,$2,$3,$4)
           ON CONFLICT (project_id, user_id) DO UPDATE SET role=$4`,
    [id("pm"), projectId, target.id, role]);
  await notify({ orgId: org?.orgId ?? null, userId: target.id, type: "invite",
    title: "You've been added to a project", body: `You were added to a project as ${role.replace(/_/g, " ")}.`,
    link: `/projects/${projectId}`, email: true });
  await writeAudit({ orgId: org?.orgId ?? null, userId: actorId, action: "create", entity: "project_member", entityId: projectId, after: { email, role } });
}

// Super-admin creates another platform admin account (set-password email sent).
export async function createAdminAccount(email: string, name: string, actorId: string): Promise<void> {
  const existing = await one<{ id: string }>(`SELECT id FROM app_user WHERE email=$1`, [email]);
  if (existing) {
    await q(`UPDATE app_user SET is_super_admin = true WHERE id=$1`, [existing.id]);
    await writeAudit({ userId: actorId, action: "update", entity: "app_user", entityId: existing.id, after: { promotedToAdmin: true } });
    return;
  }
  const uid = id("usr");
  const displayName = name || email.split("@")[0];
  await q(`INSERT INTO app_user (id, email, name, status, is_super_admin) VALUES ($1,$2,$3,'invited',true)`, [uid, email, displayName]);
  await q(`INSERT INTO user_profile (id, user_id) VALUES ($1,$2)`, [id("up"), uid]);
  // attach to the first org so they share the tenant
  const org = await one<{ id: string }>(`SELECT id FROM organization ORDER BY created_at LIMIT 1`);
  const adminRole = await one<{ id: string }>(`SELECT id FROM role WHERE key='org_admin' LIMIT 1`);
  if (org) await q(`INSERT INTO org_membership (id, org_id, user_id, role_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [id("om"), org.id, uid, adminRole?.id ?? null]);
  await issuePasswordToken(uid, "invite", email, displayName);
  await writeAudit({ userId: actorId, action: "create", entity: "app_user", entityId: uid, after: { email, admin: true } });
}


const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 90);

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "org";
}

export async function signupOrganization(input: {
  orgName: string; adminName: string; adminEmail: string; password: string;
}): Promise<{ userId: string } | { error: string }> {
  const email = input.adminEmail.trim().toLowerCase();
  if (!email || !input.password || input.password.length < 8) return { error: "A valid email and an 8+ character password are required." };
  if (await one(`SELECT id FROM app_user WHERE email=$1`, [email])) return { error: "An account with that email already exists." };

  // unique slug
  let slug = slugify(input.orgName);
  let n = 1;
  while (await one(`SELECT id FROM organization WHERE slug=$1`, [slug])) { slug = `${slugify(input.orgName)}-${n++}`; }

  const orgId = id("org");
  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();
  await q(`INSERT INTO organization (id, name, slug, plan, trial_ends_at, status) VALUES ($1,$2,$3,'trial',$4,'active')`,
    [orgId, input.orgName.trim() || "My Organization", slug, trialEnds]);

  const adminRoleId = id("role");
  await q(`INSERT INTO role (id, org_id, key, name, is_system, permissions) VALUES ($1,$2,'org_admin','Organization Admin',true,'[]')`,
    [adminRoleId, orgId]);

  const uid = id("usr");
  await q(`INSERT INTO app_user (id, email, name, password_hash, status, is_super_admin) VALUES ($1,$2,$3,$4,'active',false)`,
    [uid, email, input.adminName.trim() || email.split("@")[0], await hashPassword(input.password)]);
  await q(`INSERT INTO user_profile (id, user_id) VALUES ($1,$2)`, [id("up"), uid]);
  await q(`INSERT INTO org_membership (id, org_id, user_id, role_id, status) VALUES ($1,$2,$3,$4,'active')`,
    [id("om"), orgId, uid, adminRoleId]);

  await writeAudit({ orgId, userId: uid, action: "create", entity: "organization", entityId: orgId, after: { name: input.orgName, plan: "trial" } });
  return { userId: uid };
}

// Returns the user's primary organisation + trial state (for banners/guards).
export async function getUserOrg(userId: string): Promise<{ id: string; name: string; plan: string; status: string; trialEndsAt: string | null; isOrgAdmin: boolean } | null> {
  return one(
    `SELECT o.id, o.name, o.plan, o.status, o.trial_ends_at AS "trialEndsAt",
            EXISTS(SELECT 1 FROM org_membership m JOIN role r ON r.id=m.role_id
                   WHERE m.org_id=o.id AND m.user_id=$1 AND r.key='org_admin') AS "isOrgAdmin"
     FROM organization o JOIN org_membership m ON m.org_id=o.id
     WHERE m.user_id=$1 ORDER BY o.created_at LIMIT 1`, [userId]
  );
}
