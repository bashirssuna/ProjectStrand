import { getPayeeByToken, linkExpired, SIGN_LINK_TTL_HOURS } from "@/server/services/payment-slips";
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
      <div style={{ width: "100%", maxWidth: 640, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 28, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>{children}</div>
    </div>
  );

  if (!data) {
    return <Shell><h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Link not found</h1>
      <p style={{ color: "#555" }}>This signing link is invalid. Please contact the organisation that sent it.</p></Shell>;
  }

  const { payee, slip, org, siblings } = data;
  const done = sp.done === "1" || payee.signed;
  const expired = !done && (sp.err === "expired" || linkExpired(payee.linkSentAt));

  if (done) {
    return <Shell>
      {org.logoDataUrl && <img src={org.logoDataUrl} alt="" style={{ height: 44, marginBottom: 10 }} />}
      <div style={{ fontSize: 13, color: "#666" }}>{org.name}</div>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "10px 0 6px", color: "#15803d" }}>✓ Signed — thank you</h1>
      <p style={{ color: "#444" }}>Your signature for the payment of <strong>{money(payee.amount, slip.currency)}</strong> ({slip.title}) has been recorded{payee.signedAt ? ` on ${fmtDate(payee.signedAt)}` : ""}. You can close this page.</p>
    </Shell>;
  }

  if (expired) {
    return <Shell>
      {org.logoDataUrl && <img src={org.logoDataUrl} alt="" style={{ height: 44, marginBottom: 10 }} />}
      <div style={{ fontSize: 13, color: "#666" }}>{org.name}</div>
      <h1 style={{ fontSize: 21, fontWeight: 700, margin: "10px 0 6px", color: "#b45309" }}>This signing link has expired</h1>
      <p style={{ color: "#444" }}>For security, signing links are valid for {SIGN_LINK_TTL_HOURS} hours after they are sent. Please ask {org.name} to send you a new link.</p>
    </Shell>;
  }

  const isGroup = siblings.length > 1;

  // Redacted placeholder bar for other recipients' cells (no real data is sent here).
  const Bar = ({ w }: { w: number | string }) => (
    <div style={{ height: 11, width: w, maxWidth: "100%", background: "#cbd5e1", borderRadius: 5, filter: "blur(2.5px)", opacity: 0.75 }} />
  );
  const cell: React.CSSProperties = { borderBottom: "1px solid #eee", padding: "9px 10px", fontSize: 13, verticalAlign: "middle" };
  const hd: React.CSSProperties = { ...cell, background: "#f8fafc", fontWeight: 600, fontSize: 12, color: "#475569", textAlign: "left", borderBottom: "1px solid #e2e8f0" };

  return (
    <Shell>
      {org.logoDataUrl && <img src={org.logoDataUrl} alt="" style={{ height: 44, marginBottom: 10 }} />}
      <div style={{ fontSize: 13, color: "#666" }}>{org.name}{org.address ? ` · ${org.address}` : ""}</div>
      <h1 style={{ fontSize: 21, fontWeight: 700, margin: "10px 0 4px" }}>Confirm receipt of payment</h1>
      <p style={{ color: "#555", fontSize: 14, marginBottom: 16 }}>
        {isGroup
          ? "Your row is highlighted below — the other recipients' details are hidden for privacy. Please sign against your name. No account or sign-up is needed."
          : "Please sign against your name to confirm you are receiving this payment. No account or sign-up is needed."}
      </p>

      {isGroup ? (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", marginBottom: 18 }}>
          <div style={{ padding: "8px 10px", fontSize: 12, color: "#64748b", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between" }}>
            <span>{slip.title}</span><span>Ref {slip.number} · {fmtDate(slip.slipDate)}</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 460 }}>
              <thead><tr>
                <th style={{ ...hd, width: 36 }}>No.</th><th style={hd}>Name</th><th style={hd}>Payment for</th>
                <th style={{ ...hd, textAlign: "right" }}>Amount</th><th style={{ ...hd, width: 110 }}>Signature</th>
              </tr></thead>
              <tbody>
                {siblings.map((sib) => {
                  const mine = sib.id === payee.id;
                  if (mine) {
                    return (
                      <tr key={sib.id} style={{ background: "#fff7ed" }}>
                        <td style={{ ...cell, fontWeight: 700 }}>{payee.idx}</td>
                        <td style={{ ...cell, fontWeight: 600 }}>{payee.name} <span style={{ color: "#c2410c", fontSize: 11, fontWeight: 700 }}>← you</span></td>
                        <td style={cell}>{payee.paymentFor ?? slip.category ?? slip.title}</td>
                        <td style={{ ...cell, textAlign: "right", fontWeight: 700, whiteSpace: "nowrap" }}>{money(payee.amount, slip.currency)}</td>
                        <td style={{ ...cell, color: "#c2410c", fontSize: 11, fontWeight: 700 }}>Sign below ↓</td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={sib.id}>
                      <td style={cell}><Bar w={14} /></td>
                      <td style={cell}><Bar w={"70%"} /></td>
                      <td style={cell}><Bar w={"55%"} /></td>
                      <td style={cell}><div style={{ display: "flex", justifyContent: "flex-end" }}><Bar w={64} /></div></td>
                      <td style={cell}><Bar w={48} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 18, fontSize: 14 }}>
          <tbody>
            {[["Name", payee.name], ["Payment for", payee.paymentFor ?? slip.category ?? slip.title], ["Reference", slip.number]].map(([k, v]) => (
              <tr key={k}><td style={{ padding: "6px 0", color: "#666", width: 130 }}>{k}</td><td style={{ padding: "6px 0", fontWeight: 500 }}>{v}</td></tr>
            ))}
            <tr><td style={{ padding: "6px 0", color: "#666" }}>Amount</td><td style={{ padding: "6px 0", fontWeight: 700, fontSize: 18 }}>{money(payee.amount, slip.currency)}</td></tr>
          </tbody>
        </table>
      )}

      {sp.err === "sign" && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>Please draw or type your signature first.</div>}

      <form action={recordPayeeSignatureAction}>
        <input type="hidden" name="token" value={token} />
        <label style={{ fontSize: 13, fontWeight: 600, display: "block", marginBottom: 4 }}>Your signature{isGroup ? ` — ${payee.name}` : ""}</label>
        <SignField name="signature" initialName={payee.name} />
        <input type="hidden" name="signedName" value={payee.name} />
        <button type="submit" className="btn btn-primary" style={{ marginTop: 14, width: "100%" }}>I confirm receipt and sign</button>
      </form>
      <p style={{ color: "#888", fontSize: 11, marginTop: 12 }}>By signing you confirm the details above are correct. This record is kept by {org.name}. This link is valid for {SIGN_LINK_TTL_HOURS} hours from when it was sent.</p>
    </Shell>
  );
}
