// Provider abstraction. Local dev logs to the console; production wires a real
// transport (Resend/Postmark/SendGrid) behind the same sendEmail() signature.
export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  ics?: string;
};

export async function sendEmail(msg: EmailMessage): Promise<{ status: "sent" | "failed"; error?: string }> {
  const provider = process.env.EMAIL_PROVIDER || "console";

  if (provider === "resend" && process.env.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || "Project Strand <onboarding@resend.dev>",
          to: msg.to, subject: msg.subject, html: msg.html,
        }),
      });
      if (res.ok) return { status: "sent" };
      return { status: "failed", error: `Resend HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    } catch (err) {
      return { status: "failed", error: (err as Error).message };
    }
  }

  if (provider === "smtp" && process.env.SMTP_HOST) {
    try {
      const nodemailer = await import("nodemailer");
      const port = Number(process.env.SMTP_PORT || 465);
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        // Shared hosts (e.g. HostGator) often present a cert for the server
        // hostname, not your domain. Set SMTP_TLS_INSECURE=true to accept it.
        ...(process.env.SMTP_TLS_INSECURE === "true" ? { tls: { rejectUnauthorized: false } } : {}),
        connectionTimeout: 15000,
        greetingTimeout: 10000,
      });
      await transport.sendMail({
        from: process.env.EMAIL_FROM || process.env.SMTP_USER,
        to: msg.to, subject: msg.subject, html: msg.html,
        ...(msg.ics ? { icalEvent: { content: msg.ics, method: "REQUEST" } } : {}),
      });
      return { status: "sent" };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[email:smtp] send failed:", (err as Error).message);
      return { status: "failed", error: (err as Error).message };
    }
  }

  // console (dev default): print the message + any links so invites/resets are testable
  // eslint-disable-next-line no-console
  console.log(`\n[email:${provider}] → ${msg.to}\n  subject: ${msg.subject}\n  ${msg.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`);
  return { status: "sent" };
}

// Minimal RFC5545 VEVENT for "add to calendar" links / .ics attachments.
export function buildICS(opts: {
  uid: string; title: string; start: Date; end: Date; url?: string; description?: string;
}): string {
  const z = (d: Date) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Project Strand//EN",
    "BEGIN:VEVENT", `UID:${opts.uid}`, `DTSTAMP:${z(new Date())}`,
    `DTSTART:${z(opts.start)}`, `DTEND:${z(opts.end)}`,
    `SUMMARY:${opts.title}`,
    opts.description ? `DESCRIPTION:${opts.description}` : "",
    opts.url ? `URL:${opts.url}` : "",
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
}
