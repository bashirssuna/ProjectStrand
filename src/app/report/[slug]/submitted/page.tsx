import Link from "next/link";

export default async function ReportSubmittedPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ code?: string }> }) {
  const { slug } = await params;
  const { code } = await searchParams;

  return (
    <div className="light" style={{ minHeight: "100vh", background: "#eef2f7", color: "#0f1422" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "60px 20px" }}>
        <div className="card p-6 text-center">
          <div style={{ fontSize: 40 }}>✓</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>Report submitted</h1>
          <p style={{ color: "#475569", marginTop: 8, fontSize: 14 }}>Thank you. Your report has been securely received and will be reviewed confidentially.</p>

          <div style={{ margin: "20px 0", padding: "16px", borderRadius: 10, background: "#0f1422", color: "#fff" }}>
            <div style={{ fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: "#94a3b8" }}>Your tracking code</div>
            <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: 3, fontFamily: "monospace", marginTop: 4 }}>{code ?? "—"}</div>
          </div>

          <p style={{ color: "#475569", fontSize: 13 }}>Save this code now. It is the only way to follow up on your report, read responses, or add information — without revealing your identity. It cannot be recovered if lost.</p>

          <div className="mt-5 flex flex-col gap-2">
            <Link href={`/report/track?code=${code ?? ""}`} className="btn btn-primary">Track this report</Link>
            <Link href={`/report/${slug}`} className="btn">Submit another report</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
