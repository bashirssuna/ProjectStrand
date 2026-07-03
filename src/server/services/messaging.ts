import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";

// Direct employee-to-employee messaging, strictly scoped to one organisation.
// Both parties are app_users; the searchable people-directory is the active
// employee list (name/email). A valid counterpart is either an active employee
// with a login, or a member of the same organisation (e.g. an admin/PI).

export type DirectoryPerson = { userId: string; name: string; email: string | null; department: string | null; jobTitle: string | null };
export type Conversation = { userId: string; name: string; email: string | null; lastBody: string | null; lastAt: string | null; fromMe: boolean; unread: number };
export type ThreadMessage = { id: string; fromMe: boolean; body: string; createdAt: string };
export type Peer = { userId: string; name: string; email: string | null; department: string | null };

// The organisation the current user belongs to (works for both employees with a
// login and org members/admins). Null if the user is not tied to an org.
export async function resolveUserOrg(userId: string): Promise<string | null> {
  const r = await one<{ orgId: string | null }>(
    `SELECT COALESCE(
       (SELECT org_id FROM employee WHERE user_id=$1 AND status <> 'terminated' LIMIT 1),
       (SELECT org_id FROM org_membership WHERE user_id=$1 LIMIT 1)
     ) AS "orgId"`, [userId]);
  return r?.orgId ?? null;
}

// True if `userId` may participate in messaging within `orgId`.
export async function isOrgParticipant(orgId: string, userId: string): Promise<boolean> {
  const r = await one<{ ok: number }>(
    `SELECT 1 AS ok WHERE
       EXISTS (SELECT 1 FROM employee WHERE org_id=$1 AND user_id=$2 AND status <> 'terminated')
       OR EXISTS (SELECT 1 FROM org_membership WHERE org_id=$1 AND user_id=$2)`, [orgId, userId]);
  return !!r;
}

// Search the active employee directory by name or email (excluding the caller,
// and only those with a login who can therefore receive/read messages).
export async function searchDirectory(orgId: string, meUserId: string, term: string, limit = 25): Promise<DirectoryPerson[]> {
  const like = `%${term.trim()}%`;
  return q<DirectoryPerson>(
    `SELECT e.user_id AS "userId", (e.first_name || ' ' || e.last_name) AS name, e.email, e.department, e.job_title AS "jobTitle"
     FROM employee e
     WHERE e.org_id=$1 AND e.status <> 'terminated' AND e.user_id IS NOT NULL AND e.user_id <> $2
       AND ($3 = '' OR (e.first_name || ' ' || e.last_name) ILIKE $4 OR COALESCE(e.email,'') ILIKE $4)
     ORDER BY name
     LIMIT $5`, [orgId, meUserId, term.trim(), like, limit]);
}

// Existing conversations for the caller, most-recent first, with unread counts.
export async function listConversations(orgId: string, meUserId: string): Promise<Conversation[]> {
  return q<Conversation>(
    `WITH peers AS (
       SELECT CASE WHEN from_user_id=$2 THEN to_user_id ELSE from_user_id END AS peer,
              MAX(created_at) AS last_at
       FROM message
       WHERE org_id=$1 AND (from_user_id=$2 OR to_user_id=$2)
       GROUP BY peer
     )
     SELECT p.peer AS "userId", u.name, u.email, p.last_at AS "lastAt",
            (SELECT m.body FROM message m
              WHERE m.org_id=$1 AND ((m.from_user_id=$2 AND m.to_user_id=p.peer) OR (m.from_user_id=p.peer AND m.to_user_id=$2))
              ORDER BY m.created_at DESC LIMIT 1) AS "lastBody",
            (SELECT (m.from_user_id=$2) FROM message m
              WHERE m.org_id=$1 AND ((m.from_user_id=$2 AND m.to_user_id=p.peer) OR (m.from_user_id=p.peer AND m.to_user_id=$2))
              ORDER BY m.created_at DESC LIMIT 1) AS "fromMe",
            (SELECT COUNT(*) FROM message m
              WHERE m.org_id=$1 AND m.to_user_id=$2 AND m.from_user_id=p.peer AND m.read_at IS NULL)::int AS unread
     FROM peers p JOIN app_user u ON u.id=p.peer
     ORDER BY p.last_at DESC`, [orgId, meUserId]);
}

// Resolve a counterpart's identity (only within the caller's org). Prefers the
// employee record for department; falls back to app_user for name/email.
export async function getPeer(orgId: string, peerUserId: string): Promise<Peer | null> {
  if (!(await isOrgParticipant(orgId, peerUserId))) return null;
  return one<Peer>(
    `SELECT u.id AS "userId", u.name, u.email,
            (SELECT e.department FROM employee e WHERE e.user_id=u.id AND e.org_id=$1 LIMIT 1) AS department
     FROM app_user u WHERE u.id=$2`, [orgId, peerUserId]);
}

// The full thread between the caller and a peer, oldest first. Marks the peer's
// messages to the caller as read as a side effect (opening a chat = reading it).
export async function getThread(orgId: string, meUserId: string, peerUserId: string): Promise<ThreadMessage[]> {
  const rows = await q<ThreadMessage>(
    `SELECT id, (from_user_id=$3) AS "fromMe", body, created_at AS "createdAt"
     FROM message
     WHERE org_id=$1 AND ((from_user_id=$3 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$3))
     ORDER BY created_at ASC`, [orgId, peerUserId, meUserId]);
  await q(`UPDATE message SET read_at=now() WHERE org_id=$1 AND to_user_id=$2 AND from_user_id=$3 AND read_at IS NULL`,
    [orgId, meUserId, peerUserId]);
  return rows;
}

// Send a message. Both parties must belong to the org; empty bodies are ignored.
export async function sendMessage(orgId: string, fromUserId: string, toUserId: string, body: string): Promise<boolean> {
  const text = body.trim();
  if (!text || fromUserId === toUserId) return false;
  if (!(await isOrgParticipant(orgId, fromUserId)) || !(await isOrgParticipant(orgId, toUserId))) return false;
  await q(`INSERT INTO message (id, org_id, from_user_id, to_user_id, body) VALUES ($1,$2,$3,$4,$5)`,
    [id("msg"), orgId, fromUserId, toUserId, text.slice(0, 4000)]);
  return true;
}

export async function unreadMessageCount(orgId: string, meUserId: string): Promise<number> {
  return (await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM message WHERE org_id=$1 AND to_user_id=$2 AND read_at IS NULL`, [orgId, meUserId]))?.c ?? 0;
}
