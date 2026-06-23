import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { listItems, isLow } from "@/server/services/inventory";
import { money, fmtDateTime, ccyTotal } from "@/lib/format";
import { label } from "@/lib/enums";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

const TD = { padding: "5px 8px", borderBottom: "1px solid #e5e5e5", fontSize: 12.5 } as const;
const TH = { padding: "6px 8px", borderBottom: "2px solid #333", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 0.4, color: "#333" };

export default async function PrintInventoryPage({ searchParams }: { searchParams: Promise<{ itemType?: string; search?: string }> }) {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const sp = await searchParams;
  const items = await listItems(org.id, { itemType: sp.itemType, search: sp.search, status: "active" });
  const cur = org.displayCurrency ?? org.baseCurrency ?? "USD";
  const byCcy: Record<string, number> = {};
  for (const i of items) { const c = i.currency ?? cur; byCcy[c] = (byCcy[c] ?? 0) + i.balance * i.unitCost; }
  const totals = ccyTotal(byCcy, cur);
  const lh = await getLetterhead(org.id);

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 28px", fontSize: 13 }}>
        <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}><PrintButton /></div>
        <PrintLetterhead lh={lh} subtitle="Stock & Asset Inventory" />

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#444", margin: "14px 0 10px" }}>
          <span>{items.length} active item{items.length === 1 ? "" : "s"}{sp.itemType ? ` · ${label(sp.itemType)}` : ""}</span>
          <span>Printed: {fmtDateTime(new Date())}</span>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={{ ...TH, textAlign: "left" }}>Code</th>
            <th style={{ ...TH, textAlign: "left" }}>Item</th>
            <th style={{ ...TH, textAlign: "left" }}>Type</th>
            <th style={{ ...TH, textAlign: "right" }}>Balance</th>
            <th style={{ ...TH, textAlign: "right" }}>Reorder</th>
            <th style={{ ...TH, textAlign: "right" }}>Unit cost</th>
            <th style={{ ...TH, textAlign: "right" }}>Value</th>
          </tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td style={{ ...TD, fontFamily: "monospace", fontSize: 11.5 }}>{i.code ?? "—"}</td>
                <td style={TD}>{i.name}{i.category ? <span style={{ color: "#777", fontSize: 11, display: "block" }}>{i.category}</span> : null}</td>
                <td style={TD}>{label(i.itemType)}</td>
                <td style={{ ...TD, textAlign: "right" }}>{i.balance} {i.unit}{isLow(i) ? " ⚠" : ""}</td>
                <td style={{ ...TD, textAlign: "right" }}>{i.reorderLevel || "—"}</td>
                <td style={{ ...TD, textAlign: "right" }}>{money(i.unitCost, i.currency ?? cur)}</td>
                <td style={{ ...TD, textAlign: "right" }}>{money(i.balance * i.unitCost, i.currency ?? cur)}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td style={TD} colSpan={7}>No active stock items.</td></tr>}
          </tbody>
        </table>

        <div style={{ marginTop: 14, textAlign: "right", fontSize: 13 }}>
          <strong>Total stock value: </strong>
          {totals.mixed ? totals.parts.map(([c, v]) => money(v, c)).join("  ·  ") : totals.value}
        </div>

        <div style={{ marginTop: 40, fontSize: 11, color: "#666", borderTop: "1px solid #ddd", paddingTop: 8 }}>
          Inventory valuation at standard unit cost. ⚠ marks items at or below their reorder level.
        </div>
      </div>
    </div>
  );
}
