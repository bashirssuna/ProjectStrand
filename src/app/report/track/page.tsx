import Link from "next/link";
import { getReportByCode, listMessages, WB_CLOSED } from "@/server/services/whistleblower";
import { label } from "@/lib/enums";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { addReporterMessageAction } from "@/app/actions";

export default async function ReportTrackPage({ searchParams }: { searchParams: Promise<{ code?: string; err?: string; sent?: string }> }) {
  const sp = await searchParams;
  const code = (sp.code || "").trim();
  const report = code ? await getReportByCode(code) : null;
  const messages = report ? await listMessages(report.id, { includeInternal: false }) : [];
  const closed = report ? WB_CLOSED.includes(report.status) : false;

  return (
    <div className="light" style={{ minHeight: "100vh", background: "#eef2f7", color: "#0f1422" }}>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "40px 20px" }}>
        <div className="text-center mb-5">
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Track a confidential report</h1>
          <p style={{ color: "#475569", marginTop: 6, fontSize: 14 }}>Enter the tracking code you received when you submitted your report.</p>
        </div>

        <form method="GET" className="card p-4 mb-5 flex flex-wrap gap-2 items-end">
          <div className="flex-1" style={{ minWidth: 200 }}><label className="label">Tracking code</label><input name="code" defaultValue={code} className="input" placeholder="e.g. A1B2C3D4E5F6" style={{ fontFamily: "monospace", letterSpacing: 2 }} /></div>
          <button className="btn btn-primary" type="submit">Look up</button>
        </form>

        {sp.err === "code" && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>That tracking code was not found. Check it and try again.</div>}
        {code && !report && sp.err !== "code" && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>No report matches that code.</div>}
        {sp.sent && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Your message was added to the report.</div>}

        {report && (
          <>
            <div className="card p-4 mb-4">
              <div className="flex items-center justify-between">
                <div><div style={{ fontWeight: 600 }}>{report.title}</div><div className="text-xs" style={{ color: "#64748b" }}>{report.orgName} · submitted {fmtDate(report.createdAt)}</div></div>
                <span className="badge" style={{ padding: "3px 10px", borderRadius: 999, background: closed ? "#e2e8f0" : "#dbeafe", color: closed ? "#475569" : "#1d4ed8", fontSize: 12, fontWeight: 600 }}>{label(report.status)}</span>
              </div>
              {report.category && <div className="text-sm mt-2" style={{ color: "#475569" }}>{report.category}</div>}
              {closed && report.outcome && <div className="text-sm mt-2"><span className="label">Outcome</span> {label(report.outcome)}</div>}
            </div>

            <div className="text-sm font-medium mb-2">Correspondence</div>
            <div className="space-y-2 mb-4">
              {messages.length === 0 ? <div className="card p-3 text-sm" style={{ color: "#64748b" }}>No correspondence yet. Reviewers may reach out here; check back using your code.</div> : messages.map((m) => (
                <div key={m.id} className="card p-3" style={{ borderLeft: `3px solid ${m.sender === "reviewer" ? "#2563eb" : "#94a3b8"}` }}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium" style={{ color: m.sender === "reviewer" ? "#1d4ed8" : "#475569" }}>{m.sender === "reviewer" ? (m.authorName ? `Response — ${m.authorName}` : "Response from reviewer") : "You"}</span>
                    <span className="text-xs" style={{ color: "#94a3b8" }}>{fmtDateTime(m.createdAt)}</span>
                  </div>
                  {m.body && <p className="text-sm mt-1 whitespace-pre-wrap">{m.body}</p>}
                </div>
              ))}
            </div>

            {!closed ? (
              <div className="card p-4">
                <div className="text-sm font-medium mb-2">Add information</div>
                <form action={addReporterMessageAction} className="grid gap-2">
                  <input type="hidden" name="code" value={code} />
                  <textarea name="body" rows={3} required className="input" placeholder="Add any further details or respond to a question from the reviewer." />
                  <div><label className="label">Attachment (optional)</label><input name="file" type="file" className="input" /></div>
                  <div><button className="btn btn-primary" type="submit">Send</button></div>
                </form>
              </div>
            ) : (
              <div className="card p-4 text-sm" style={{ color: "#475569" }}>This report has been closed. Thank you for raising it.</div>
            )}
          </>
        )}

        <div className="text-center mt-5 text-xs" style={{ color: "#94a3b8" }}>Your identity is not revealed by this page. Keep your tracking code private.</div>
      </div>
    </div>
  );
}
