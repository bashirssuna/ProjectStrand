import Link from "next/link";
import { requireUser } from "@/server/auth";
import { q } from "@/server/db";
import { markNotificationsReadAction } from "@/app/actions";
import { PageHeader, Empty, Badge } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";

export default async function NotificationsPage() {
  const user = await requireUser();
  const items = await q<{ id: string; type: string; title: string; body: string | null; link: string | null; read: boolean; createdAt: string }>(
    `SELECT id, type, title, body, link, read, created_at AS "createdAt"
     FROM notification WHERE user_id=$1 ORDER BY created_at DESC LIMIT 60`, [user.id]
  );
  const unread = items.filter((n) => !n.read).length;

  return (
    <div className="max-w-2xl">
      <PageHeader title="Notifications" subtitle={unread ? `${unread} unread` : "You're all caught up."}
        actions={unread ? (
          <form action={markNotificationsReadAction}><button className="btn btn-sm" type="submit">Mark all read</button></form>
        ) : undefined} />
      {items.length === 0 ? (
        <Empty title="No notifications yet" hint="Assignments, approvals and reminders will appear here." />
      ) : (
        <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
          {items.map((n) => (
            <div key={n.id} className="p-4 flex items-start gap-3" style={{ borderColor: "var(--border)", opacity: n.read ? 0.7 : 1 }}>
              {!n.read && <span className="mt-1.5 h-2 w-2 rounded-full shrink-0" style={{ background: "var(--brand)" }} />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{n.title}</span>
                  <Badge tone="muted">{label(n.type)}</Badge>
                </div>
                {n.body && <div className="text-sm mt-0.5" style={{ color: "var(--muted)" }}>{n.body}</div>}
                <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>{fmtDateTime(n.createdAt)}</div>
              </div>
              {n.link && <Link href={n.link} className="btn btn-sm shrink-0">Open</Link>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
