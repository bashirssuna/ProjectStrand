import { getCurrentUser } from "@/server/auth";
import { can } from "@/server/policy";
import { one } from "@/server/db";
import { buildICS } from "@/server/email";

export async function GET(_req: Request, { params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await params;
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const m = await one<{ projectId: string; title: string; startsAt: string; endsAt: string; url: string | null; agenda: string | null }>(
    `SELECT project_id AS "projectId", title, starts_at AS "startsAt", ends_at AS "endsAt", meeting_url AS url, agenda
     FROM meeting WHERE id=$1`, [meetingId]
  );
  if (!m) return new Response("Not found", { status: 404 });
  if (!(await can(m.projectId, "project.view"))) return new Response("Forbidden", { status: 403 });

  const ics = buildICS({
    uid: meetingId,
    title: m.title,
    start: new Date(m.startsAt),
    end: new Date(m.endsAt || m.startsAt),
    url: m.url ?? undefined,
    description: m.agenda ?? undefined,
  });
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${m.title.replace(/[^\w.\- ]+/g, "")}.ics"`,
    },
  });
}
