import { sendDueRenewalReminders } from "@/server/services/billing";
import { autoArchiveOldJournals } from "@/server/services/ledger";

// Hit this on a schedule (e.g. Render Cron / any pinger) to send subscription
// renewal reminders. If CRON_SECRET is set, the caller must supply it via
// ?key=… or an "Authorization: Bearer …" header. Safe to call repeatedly — the
// per-cycle reminder log prevents duplicate emails.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const url = new URL(req.url);
    const provided = url.searchParams.get("key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (provided !== secret) return new Response("Unauthorized", { status: 401 });
  }
  try {
    const sent = await sendDueRenewalReminders();
    // Housekeeping: tidy the general journal by archiving entries older than 12 months
    // across all organisations. Presentational only — does not affect any balances.
    const journalsArchived = await autoArchiveOldJournals();
    return Response.json({ ok: true, reminders_sent: sent, journals_archived: journalsArchived });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
