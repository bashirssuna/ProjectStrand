import { getPayeeByToken } from "@/server/services/payment-slips";
import { recordPayeeSignatureAction } from "@/app/actions";
import { SignField } from "@/components/sign-field";
import { money, fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SignPage({ params, searchParams }: {
  params: Promise<{ token: string }>; searchParams: Promise<{ done?: string; err?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const data = await getPayeeByToken(token);

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="light" style={{ background: "#f3f4f6", color: "#111", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 560, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 28, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>{children}</div>
    </div>
  );

  if (!data) {
    return <Shell><h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Link not found</h1>
      <p style={{ color: "#555" }}>This signing link is invalid or has expired. Please contact the organisation that sent it.</p></Shell>;
  }

  const { payee, slip, org } = data;
  const done = sp.done === "1" || payee.signed;

  if (done) {
    return <Shell>
      {org.logoDataUrl && <img src={org.logoDataUrl} alt="" style={{ height: 44, marginBottom: 10 }} />}
      <div style={{ fontSize: 13, color: "#666" }}>{org.name}</div>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "10px 0 6px", color: "#15803d" }}>✓ Signed — thank you</h1>
      <p style={{ color: "#444" }}>Your signature for the payment of <strong>{money(payee.amount, slip.currency)}</strong> ({slip.title}) has been recorded{payee.signedAt ? ` on ${fmtDate(payee.signedAt)}` : ""}. You can close this page.</p>
    </Shell>;
  }

  return (
    <Shell>
      {org.logoDataUrl && <img src={org.logoDataUrl} alt="" style={{ height: 44, marginBottom: 10 }} />}
      <div style={{ fontSize: 13, color: "#666" }}>{org.name}{org.address ? ` · ${org.address}` : ""}</div>
      <h1 style={{ fontSize: 21, fontWeight: 700, margin: "10px 0 4px" }}>Confirm receipt of payment</h1>
      <p style={{ color: "#555", fontSize: 14, marginBottom: 16 }}>Please sign against your name to confirm you are receiving this payment. No account or sign-up is needed.</p>

      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 18, fontSize: 14 }}>
        <tbody>
          {[["Name", payee.name], ["Payment for", payee.paymentFor ?? slip.category ?? slip.title], ["Reference", slip.number]].map(([k, v]) => (
            <tr key={k}><td style={{ padding: "6px 0", color: "#666", width: 130 }}>{k}</td><td style={{ padding: "6px 0", fontWeight: 500 }}>{v}</td></tr>
          ))}
          <tr><td style={{ padding: "6px 0", color: "#666" }}>Amount</td><td style={{ padding: "6px 0", fontWeight: 700, fontSize: 18 }}>{money(payee.amount, slip.currency)}</td></tr>
        </tbody>
      </table>

      {sp.err === "sign" && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>Please draw or type your signature first.</div>}

      <form action={recordPayeeSignatureAction}>
        <input type="hidden" name="token" value={token} />
        <label style={{ fontSize: 13, fontWeight: 600, display: "block", marginBottom: 4 }}>Your signature</label>
        <SignField name="signature" initialName={payee.name} />
        <input type="hidden" name="signedName" value={payee.name} />
        <button type="submit" className="btn btn-primary" style={{ marginTop: 14, width: "100%" }}>I confirm receipt and sign</button>
      </form>
      <p style={{ color: "#888", fontSize: 11, marginTop: 12 }}>By signing you confirm that the details above are correct. This record is kept by {org.name}.</p>
    </Shell>
  );
}
