import Link from "next/link";
import { notFound } from "next/navigation";
import { one } from "@/server/db";
import { WB_CATEGORIES } from "@/server/services/whistleblower";
import { submitWhistleblowerReportAction } from "@/app/actions";

export default async function ReportIntakePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ err?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const org = await one<{ name: string }>(`SELECT name FROM organization WHERE slug=$1`, [slug]);
  if (!org) notFound();

  return (
    <div className="light" style={{ minHeight: "100vh", background: "#eef2f7", color: "#0f1422" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "40px 20px" }}>
        <div className="text-center mb-6">
          <div style={{ fontSize: 13, letterSpacing: 1, textTransform: "uppercase", color: "#64748b" }}>{org.name}</div>
          <h1 style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>Confidential Reporting Channel</h1>
          <p style={{ color: "#475569", marginTop: 8, fontSize: 14 }}>Use this secure form to report fraud, misconduct, safeguarding concerns or other wrongdoing. You may submit anonymously. You will receive a tracking code to follow up confidentially.</p>
        </div>

        {sp.err === "req" && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A title and description are required.</div>}

        <div className="card p-5">
          <form action={submitWhistleblowerReportAction} className="grid gap-3">
            <input type="hidden" name="slug" value={slug} />
            <div><label className="label">Category</label><select name="category" className="select"><option value="">Select…</option>{WB_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            <div><label className="label">Summary / title *</label><input name="title" required className="input" placeholder="Brief summary of your concern" /></div>
            <div><label className="label">What happened? *</label><textarea name="description" required rows={6} className="input" placeholder="Describe the concern in as much detail as you can — what, when, who, and any evidence." /></div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div><label className="label">Date of incident</label><input name="incidentDate" type="date" className="input" /></div>
              <div><label className="label">Location / department</label><input name="location" className="input" /></div>
            </div>
            <div><label className="label">Persons involved</label><input name="personsInvolved" className="input" placeholder="Names or roles, if known" /></div>
            <div><label className="label">Supporting document (optional)</label><input name="file" type="file" className="input" /></div>

            <label className="flex items-start gap-2 text-sm mt-1"><input type="checkbox" name="retaliation" /> <span>I am concerned about retaliation for making this report.</span></label>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="anonymous" defaultChecked /> <span>Submit anonymously (recommended). Untick if you are willing to be contacted.</span></label>

            <details className="text-sm">
              <summary className="cursor-pointer" style={{ color: "#475569" }}>Provide contact details (only if not anonymous)</summary>
              <div className="grid sm:grid-cols-2 gap-3 mt-2">
                <div><label className="label">Your name</label><input name="reporterName" className="input" /></div>
                <div><label className="label">Contact (email / phone)</label><input name="reporterContact" className="input" /></div>
              </div>
            </details>

            <div className="mt-2"><button className="btn btn-primary" type="submit">Submit report</button></div>
            <p className="text-xs" style={{ color: "#64748b" }}>Reports are reviewed confidentially by designated officers. If anyone is in immediate danger, contact local emergency services.</p>
          </form>
        </div>

        <div className="text-center mt-5 text-sm">
          <Link href="/report/track" style={{ color: "#2563eb" }}>Already submitted? Track your report →</Link>
        </div>
      </div>
    </div>
  );
}
