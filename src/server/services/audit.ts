import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { sendEmail } from "@/server/email";

const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000";

export async function writeAudit(input: {
  orgId?: string | null;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
}): Promise<void> {
  await q(
    `INSERT INTO audit_log (id, org_id, user_id, action, entity, entity_id, before, after, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id("aud"), input.orgId ?? null, input.userId ?? null, input.action, input.entity,
      input.entityId ?? null,
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
      input.meta ? JSON.stringify(input.meta) : null,
    ]
  );
}

export async function notify(input: {
  orgId?: string | null;
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  email?: boolean;
}): Promise<void> {
  const nid = id("ntf");
  let emailStatus = "pending";
  if (input.email) {
    const u = await one<{ email: string }>(`SELECT email FROM app_user WHERE id = $1`, [input.userId]);
    if (u) {
      const r = await sendEmail({
        to: u.email,
        subject: input.title,
        html: `<p>${input.body ?? input.title}</p>${input.link ? `<p><a href="${APP_URL}${input.link}">Open in Project Strand</a></p>` : ""}`,
      });
      emailStatus = r.status;
    }
  }
  await q(
    `INSERT INTO notification (id, org_id, user_id, type, title, body, link, email_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [nid, input.orgId ?? null, input.userId, input.type, input.title,
     input.body ?? null, input.link ?? null, emailStatus]
  );
}
