import Link from "next/link";
import { requireUser } from "@/server/auth";
import { PageHeader, Empty } from "@/components/ui";
import { Icon } from "@/components/icons";
import { fmtDateTime } from "@/lib/format";
import { sendMessageAction } from "@/app/actions";
import {
  resolveUserOrg, searchDirectory, listConversations, getPeer, getThread,
  type DirectoryPerson, type Conversation, type ThreadMessage, type Peer,
} from "@/server/services/messaging";

function initials(name: string): string {
  return name.split(" ").map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  return (
    <span className="grid place-items-center shrink-0 font-semibold rounded-full"
      style={{ width: size, height: size, fontSize: size * 0.38, background: "color-mix(in srgb, var(--brand) 16%, var(--panel))", color: "var(--brand)", border: "1px solid color-mix(in srgb, var(--brand) 24%, transparent)" }}>
      {initials(name)}
    </span>
  );
}

export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ q?: string; to?: string }> }) {
  const user = await requireUser();
  const orgId = await resolveUserOrg(user.id);
  const sp = await searchParams;
  const term = (sp.q ?? "").trim();
  const to = sp.to ?? "";

  if (!orgId) {
    return (
      <div className="max-w-2xl">
        <PageHeader title="Messages" subtitle="Chat with colleagues in your organisation" />
        <Empty title="Messaging isn't available on this account" hint="Messaging is for members of an organisation. Ask your administrator to link your login to your staff record." />
      </div>
    );
  }

  const [conversations, directory, peer, thread] = await Promise.all([
    listConversations(orgId, user.id),
    term ? searchDirectory(orgId, user.id, term) : Promise.resolve([] as DirectoryPerson[]),
    to ? getPeer(orgId, to) : Promise.resolve(null as Peer | null),
    to ? getThread(orgId, user.id, to) : Promise.resolve([] as ThreadMessage[]),
  ]);

  return (
    <div>
      <PageHeader title="Messages" subtitle="Chat with colleagues in your organisation" />
      <div className="grid md:grid-cols-[320px_1fr] gap-4" style={{ minHeight: "68vh" }}>

        {/* Left — search + conversations */}
        <div className="card flex flex-col overflow-hidden" style={{ maxHeight: "72vh" }}>
          <form method="GET" className="p-3 border-b" style={{ borderColor: "var(--border)" }}>
            {to && <input type="hidden" name="to" value={to} />}
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--muted)" }}><Icon name="search" size={16} /></span>
              <input name="q" defaultValue={term} placeholder="Search staff by name or email…" className="input input-sm" style={{ paddingLeft: 30 }} autoComplete="off" />
            </div>
          </form>

          <div className="overflow-y-auto flex-1">
            {term && (
              <div className="px-3 py-2">
                <div className="nav-section" style={{ padding: "6px 4px" }}>Directory {directory.length ? `· ${directory.length}` : ""}</div>
                {directory.length === 0 ? (
                  <p className="text-xs px-1 py-2" style={{ color: "var(--muted)" }}>No active staff match “{term}”.</p>
                ) : directory.map((p: DirectoryPerson) => (
                  <Link key={p.userId} href={`/messages?to=${p.userId}`}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-[color-mix(in_srgb,var(--brand)_8%,transparent)] transition-colors">
                    <Avatar name={p.name} size={30} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium truncate">{p.name}</span>
                      <span className="block text-xs truncate" style={{ color: "var(--muted)" }}>{[p.jobTitle, p.email].filter(Boolean).join(" · ") || "—"}</span>
                    </span>
                  </Link>
                ))}
              </div>
            )}

            <div className="px-3 py-2">
              <div className="nav-section" style={{ padding: "6px 4px" }}>Conversations</div>
              {conversations.length === 0 ? (
                <p className="text-xs px-1 py-2" style={{ color: "var(--muted)" }}>No messages yet. Search above to start one.</p>
              ) : conversations.map((c: Conversation) => (
                <Link key={c.userId} href={`/messages?to=${c.userId}`}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors"
                  style={to === c.userId ? { background: "color-mix(in srgb, var(--brand) 12%, transparent)" } : undefined}>
                  <Avatar name={c.name} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{c.name}</span>
                      {c.unread > 0 && <span className="text-[10px] font-semibold rounded-full px-1.5 shrink-0" style={{ background: "var(--brand)", color: "var(--brand-fg)" }}>{c.unread}</span>}
                    </span>
                    <span className="block text-xs truncate" style={{ color: c.unread > 0 ? "var(--fg)" : "var(--muted)" }}>
                      {c.fromMe ? "You: " : ""}{c.lastBody ?? ""}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* Right — thread */}
        <div className="card flex flex-col overflow-hidden" style={{ maxHeight: "72vh" }}>
          {!to ? (
            <div className="flex-1 grid place-items-center text-center p-8">
              <div>
                <span className="icon-tile mx-auto mb-3" style={{ width: 48, height: 48 }}><Icon name="collab" size={24} /></span>
                <p className="font-display text-base font-semibold">Your messages</p>
                <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>Pick a conversation, or search for a colleague by name or email to start chatting.</p>
              </div>
            </div>
          ) : !peer ? (
            <div className="flex-1 grid place-items-center p-8">
              <Empty title="Person not found" hint="They may have left the organisation or don't have a login." />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 p-3 border-b" style={{ borderColor: "var(--border)" }}>
                <Avatar name={peer.name} size={38} />
                <div className="min-w-0">
                  <div className="font-display font-semibold leading-tight truncate">{peer.name}</div>
                  <div className="text-xs truncate" style={{ color: "var(--muted)" }}>{[peer.department, peer.email].filter(Boolean).join(" · ") || "Colleague"}</div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-2.5 flex flex-col-reverse">
                {/* column-reverse keeps the newest message in view; render newest-first */}
                {thread.length === 0 ? (
                  <p className="text-sm text-center m-auto" style={{ color: "var(--muted)" }}>No messages yet — say hello 👋</p>
                ) : [...thread].reverse().map((m: ThreadMessage) => (
                  <div key={m.id} className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
                    <div className="max-w-[76%] rounded-2xl px-3.5 py-2 text-sm"
                      style={m.fromMe
                        ? { background: "var(--brand)", color: "var(--brand-fg)", borderBottomRightRadius: 6 }
                        : { background: "var(--surface)", border: "1px solid var(--border)", borderBottomLeftRadius: 6 }}>
                      <div className="whitespace-pre-wrap break-words">{m.body}</div>
                      <div className="text-[10px] mt-1" style={{ opacity: 0.7 }}>{fmtDateTime(m.createdAt)}</div>
                    </div>
                  </div>
                ))}
              </div>

              <form action={sendMessageAction} className="p-3 border-t flex items-end gap-2" style={{ borderColor: "var(--border)" }}>
                <input type="hidden" name="to" value={to} />
                <textarea name="body" rows={1} required placeholder={`Message ${peer.name.split(" ")[0]}…`} className="textarea" style={{ resize: "none", minHeight: 40 }} />
                <button type="submit" className="btn btn-primary" title="Send"><Icon name="arrow" size={18} /></button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
