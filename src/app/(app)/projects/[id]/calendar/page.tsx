import { getProjectAccess } from "@/server/policy";
import { q } from "@/server/db";
import { createMeetingAction } from "@/app/actions";
import { SectionTitle, Empty, Badge, Field } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { blockStaff } from "../_staffblock";

export default async function CalendarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await blockStaff(id);
  const access = await getProjectAccess(id);
  const canEdit = access.permissions.has("project.edit");

  const meetings = await q<{ id: string; title: string; startsAt: string; location: string | null; url: string | null; agenda: string | null }>(
    `SELECT id, title, starts_at AS "startsAt", location, meeting_url AS url, agenda
     FROM meeting WHERE project_id=$1 ORDER BY starts_at DESC`, [id]
  );
  const events = await q<{ id: string; title: string; kind: string; startsAt: string }>(
    `SELECT id, title, kind, starts_at AS "startsAt" FROM calendar_event
     WHERE project_id=$1 AND kind <> 'meeting' ORDER BY starts_at`, [id]
  );

  return (
    <div className="grid lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <div>
          <SectionTitle>Meetings</SectionTitle>
          {meetings.length === 0 ? (
            <Empty title="No meetings scheduled" hint={canEdit ? "Schedule one on the right — attendees are notified and can add it to their calendar." : "No meetings yet."} />
          ) : (
            <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
              {meetings.map((m) => (
                <div key={m.id} className="p-4 flex items-start justify-between gap-3" style={{ borderColor: "var(--border)" }}>
                  <div className="min-w-0">
                    <div className="font-medium">{m.title}</div>
                    <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{fmtDateTime(m.startsAt)}{m.location ? ` · ${m.location}` : ""}</div>
                    {m.agenda && <div className="text-sm mt-1">{m.agenda}</div>}
                    {m.url && <a href={m.url} className="text-xs hover:underline" style={{ color: "var(--brand)" }}>{m.url}</a>}
                  </div>
                  <a href={`/api/meetings/${m.id}/ics`} className="btn btn-sm whitespace-nowrap">Add to calendar</a>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <SectionTitle>Deadlines &amp; reminders</SectionTitle>
          {events.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>Due dates and reminders from activities and reports appear here.</p>
          ) : (
            <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
              {events.map((e) => (
                <div key={e.id} className="p-3 flex items-center justify-between gap-3" style={{ borderColor: "var(--border)" }}>
                  <div className="flex items-center gap-2"><Badge tone="info">{e.kind}</Badge><span className="text-sm">{e.title}</span></div>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>{fmtDateTime(e.startsAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {canEdit && (
        <form action={createMeetingAction} className="card p-4 space-y-3 h-fit">
          <SectionTitle>Schedule a meeting</SectionTitle>
          <input type="hidden" name="projectId" value={id} />
          <Field label="Title"><input name="title" required className="input" placeholder="Quarterly review" /></Field>
          <Field label="Date &amp; time"><input type="datetime-local" name="startsAt" required className="input" /></Field>
          <Field label="Location"><input name="location" className="input" placeholder="Conference room / Zoom" /></Field>
          <Field label="Meeting link"><input name="meetingUrl" className="input" placeholder="https://…" /></Field>
          <Field label="Agenda"><textarea name="agenda" rows={2} className="textarea" /></Field>
          <button className="btn btn-primary w-full" type="submit">Schedule &amp; notify team</button>
          <p className="text-xs" style={{ color: "var(--muted)" }}>All members get a notification; each can download an .ics invite.</p>
        </form>
      )}
    </div>
  );
}
