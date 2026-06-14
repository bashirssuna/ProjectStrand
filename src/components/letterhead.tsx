import { one } from "@/server/db";

export type Letterhead = {
  name: string; logoDataUrl: string | null; address: string | null; email: string | null;
  phone: string | null; website: string | null; slogan: string | null;
};

// Fetches an organisation's letterhead details for use on printouts.
export async function getLetterhead(orgId: string): Promise<Letterhead> {
  const o = await one<Letterhead>(
    `SELECT name, logo_data_url AS "logoDataUrl", address, email, phone, website, slogan
     FROM organization WHERE id=$1`, [orgId]
  );
  return o ?? { name: "", logoDataUrl: null, address: null, email: null, phone: null, website: null, slogan: null };
}

// Renders a print letterhead: logo (if uploaded), org name, slogan, and a
// contact line (address · phone · email · web). Used at the top of every print page.
export function PrintLetterhead({ lh, subtitle }: { lh: Letterhead; subtitle?: string }) {
  const contactBits = [lh.address, lh.phone, lh.email, lh.website].filter(Boolean);
  return (
    <div style={{ textAlign: "center", borderBottom: "3px double #111", paddingBottom: 12, marginBottom: 4 }}>
      {lh.logoDataUrl && (
        <img src={lh.logoDataUrl} alt="" style={{ maxHeight: 70, maxWidth: 240, objectFit: "contain", marginBottom: 8 }} />
      )}
      <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 0.4 }}>{lh.name}</div>
      {lh.slogan && <div style={{ fontSize: 12, fontStyle: "italic", color: "#555", marginTop: 2 }}>{lh.slogan}</div>}
      {contactBits.length > 0 && (
        <div style={{ fontSize: 11, color: "#444", marginTop: 5 }}>{contactBits.join("  ·  ")}</div>
      )}
      {subtitle && <div style={{ fontSize: 12, color: "#444", marginTop: 6 }}>{subtitle}</div>}
    </div>
  );
}
