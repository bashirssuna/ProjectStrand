import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { q } from "@/server/db";
import { listContracts } from "@/server/services/contracts";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

type Align = "left" | "right";
type Register = { subtitle: string; header: string[]; aligns: Align[]; rows: string[][] };

const d = (v: unknown): string => (v ? fmtDate(v as string) : "—");

async function load(register: string, orgId: string, baseCur: string): Promise<Register | null> {
  switch (register) {
    case "contracts": {
      const rows = await listContracts(orgId);
      return {
        subtitle: "Contracts Register",
        header: ["Reference", "Title", "Provider", "Status", "Value", "Paid", "End date"],
        aligns: ["left", "left", "left", "left", "right", "right", "left"],
        rows: rows.map((c) => [c.reference ?? "—", c.title, c.vendorName ?? c.providerName ?? "—", label(c.status), money(c.contractValue, c.currency ?? baseCur), money(c.paid, c.currency ?? baseCur), d(c.endDate)]),
      };
    }
    case "vendors": {
      const v = await q<{ name: string; contactPerson: string | null; email: string | null; phone: string | null; taxId: string | null }>(
        `SELECT name, contact_person AS "contactPerson", email, phone, tax_id AS "taxId" FROM vendor WHERE org_id=$1 ORDER BY name`, [orgId]);
      return {
        subtitle: "Vendor Directory",
        header: ["Name", "Contact person", "Email", "Phone", "Tax ID"],
        aligns: ["left", "left", "left", "left", "left"],
        rows: v.map((x) => [x.name, x.contactPerson ?? "—", x.email ?? "—", x.phone ?? "—", x.taxId ?? "—"]),
      };
    }
    case "requests": {
      const r = await q<{ number: string; title: string; status: string; projectCode: string | null; currency: string; estimatedTotal: number; neededBy: unknown; requestedByName: string | null }>(
        `SELECT pr.number, pr.title, pr.status, p.code AS "projectCode", pr.currency, pr.estimated_total::float8 AS "estimatedTotal", pr.needed_by AS "neededBy", pr.requested_by_name AS "requestedByName"
         FROM purchase_request pr LEFT JOIN project p ON p.id=pr.project_id WHERE pr.org_id=$1 ORDER BY pr.created_at DESC`, [orgId]);
      return {
        subtitle: "Purchase Requests Register",
        header: ["Number", "Title", "Project", "Amount", "Status", "Needed by", "By"],
        aligns: ["left", "left", "left", "right", "left", "left", "left"],
        rows: r.map((x) => [x.number, x.title, x.projectCode ?? "—", money(x.estimatedTotal, x.currency), label(x.status), d(x.neededBy), x.requestedByName ?? "—"]),
      };
    }
    case "bills": {
      const b = await q<{ number: string; vendor: string | null; poNumber: string | null; billDate: unknown; dueDate: unknown; status: string; currency: string; total: number; amountPaid: number }>(
        `SELECT b.number, v.name AS vendor, po.number AS "poNumber", b.bill_date AS "billDate", b.due_date AS "dueDate", b.status, b.currency, b.total::float8 AS total, b.amount_paid::float8 AS "amountPaid"
         FROM vendor_bill b LEFT JOIN vendor v ON v.id=b.vendor_id LEFT JOIN purchase_order po ON po.id=b.po_id WHERE b.org_id=$1 ORDER BY b.created_at DESC`, [orgId]);
      return {
        subtitle: "Vendor Bills Register",
        header: ["Number", "Vendor", "PO", "Date", "Due", "Status", "Total", "Outstanding"],
        aligns: ["left", "left", "left", "left", "left", "left", "right", "right"],
        rows: b.map((x) => [x.number, x.vendor ?? "—", x.poNumber ?? "—", d(x.billDate), d(x.dueDate), label(x.status), money(x.total, x.currency), money(x.total - x.amountPaid, x.currency)]),
      };
    }
    default:
      return null;
  }
}

const TH = { padding: "6px 8px", borderBottom: "2px solid #333", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 0.4, color: "#333" };
const TD = { padding: "5px 8px", borderBottom: "1px solid #e5e5e5", fontSize: 12.5 } as const;

export default async function PrintProcurementRegisterPage({ params }: { params: Promise<{ register: string }> }) {
  const { register } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const baseCur = org.displayCurrency ?? org.baseCurrency ?? "USD";
  const data = await load(register, org.id, baseCur);
  if (!data) redirect("/procurement");
  const lh = await getLetterhead(org.id);

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "32px 28px", fontSize: 13 }}>
        <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}><PrintButton /></div>
        <PrintLetterhead lh={lh} subtitle={data.subtitle} />

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#444", margin: "14px 0 10px" }}>
          <span>{data.rows.length} record{data.rows.length === 1 ? "" : "s"}</span>
          <span>Printed: {fmtDateTime(new Date())}</span>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{data.header.map((h, i) => <th key={i} style={{ ...TH, textAlign: data.aligns[i] }}>{h}</th>)}</tr></thead>
          <tbody>
            {data.rows.map((r, ri) => (
              <tr key={ri}>{r.map((cell, ci) => <td key={ci} style={{ ...TD, textAlign: data.aligns[ci], fontFamily: ci === 0 ? "monospace" : undefined, fontSize: ci === 0 ? 11.5 : 12.5 }}>{cell}</td>)}</tr>
            ))}
            {data.rows.length === 0 && <tr><td style={TD} colSpan={data.header.length}>No records.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
