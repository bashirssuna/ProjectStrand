import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { listRecipients } from "@/server/services/surveys";

function csvCell(v: string | null): string {
  const s = (v ?? "").replace(/"/g, '""');
  return `"${s}"`;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) return new Response("Forbidden", { status: 403 });
  const s = await one<{ title: string }>(`SELECT title FROM survey WHERE id=$1 AND org_id=$2`, [id, org.id]);
  if (!s) return new Response("Not found", { status: 404 });
  const recipients = await listRecipients(org.id, id);

  let origin: string;
  try { origin = new URL(req.url).origin; } catch { origin = ""; }

  const header = ["Name", "Email", "Department", "Status", "Invite link"].join(",");
  const rows = recipients.map((r) =>
    [csvCell(r.name), csvCell(r.email), csvCell(r.department),
     csvCell(r.responded ? "Responded" : r.sent ? "Sent" : "Pending"),
     csvCell(`${origin}/survey/r/${r.token}`)].join(","));
  const csv = [header, ...rows].join("\r\n");
  const fname = `survey-recipients-${(s.title || "survey").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fname}"`,
    },
  });
}
