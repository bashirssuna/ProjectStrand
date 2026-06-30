import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { q } from "@/server/db";
import { listItems } from "@/server/services/inventory";
import { listContracts } from "@/server/services/contracts";
import { importEntity } from "@/server/services/imports";
import { sheetResponse, type Cell } from "@/server/services/sheets";

// Normalises a date value (Date from node-postgres, string from PGlite) to YYYY-MM-DD.
const d = (v: unknown): string => {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

export async function GET(req: Request, { params }: { params: Promise<{ scope: string }> }) {
  const { scope } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) return new Response("Forbidden", { status: 403 });
  const orgId = org.id;
  const u = new URL(req.url);
  const fmt = u.searchParams.get("format");
  const slug = (org.name || "export").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "export";

  let title = "";
  let header: string[] = [];
  let rows: Cell[][] = [];

  switch (scope) {
    case "inventory": {
      const items = await listItems(orgId, {
        search: u.searchParams.get("search") || undefined,
        itemType: u.searchParams.get("itemType") || undefined,
        status: u.searchParams.get("status") || undefined,
      });
      title = "inventory";
      header = ["Code", "Name", "Category", "Type", "Unit", "Balance", "Reorder level", "Unit cost", "Currency", "Stock value", "Status"];
      rows = items.map((i) => [i.code ?? "", i.name, i.category ?? "", i.itemType, i.unit, i.balance, i.reorderLevel, i.unitCost, i.currency ?? "", Math.round(i.balance * i.unitCost * 100) / 100, i.status]);
      break;
    }
    case "inventory-template": {
      // Blank template (header + one example row) for organisations to fill in and re-upload.
      title = "inventory-template";
      header = ["Code", "Name", "Category", "Type", "Unit", "Opening qty", "Reorder level", "Unit cost", "Currency"];
      rows = [["LAP-001", "Dell Latitude 5440 laptop", "IT equipment", "asset", "unit", 5, 1, 1200, "USD"]];
      break;
    }
    case "contracts": {
      const list = await listContracts(orgId, { status: u.searchParams.get("status") || undefined, search: u.searchParams.get("search") || undefined });
      title = "contracts";
      header = ["Reference", "Title", "Provider", "Status", "Currency", "Contract value", "Paid", "Outstanding", "Milestones done", "Milestones total", "End date"];
      rows = list.map((c) => [c.reference ?? "", c.title, c.vendorName ?? c.providerName ?? "", c.status, c.currency ?? "", c.contractValue, c.paid, Math.round((c.contractValue - c.paid) * 100) / 100, c.milestonesDone, c.milestonesTotal, d(c.endDate)]);
      break;
    }
    case "vendors": {
      const v = await q<{ name: string; contactPerson: string | null; email: string | null; phone: string | null; taxId: string | null; bankAccount: string | null; address: string | null; active: boolean }>(
        `SELECT name, contact_person AS "contactPerson", email, phone, tax_id AS "taxId", bank_account AS "bankAccount", address, active FROM vendor WHERE org_id=$1 ORDER BY name`, [orgId]
      );
      title = "vendors";
      header = ["Name", "Contact person", "Email", "Phone", "Tax ID", "Bank account", "Address", "Active"];
      rows = v.map((x) => [x.name, x.contactPerson ?? "", x.email ?? "", x.phone ?? "", x.taxId ?? "", x.bankAccount ?? "", x.address ?? "", x.active ? "Yes" : "No"]);
      break;
    }
    case "requests": {
      const r = await q<{ number: string; title: string; status: string; projectCode: string | null; lineCode: string | null; lineDesc: string | null; currency: string; estimatedTotal: number; neededBy: unknown; requestedByName: string | null }>(
        `SELECT pr.number, pr.title, pr.status, p.code AS "projectCode", bl.code AS "lineCode", bl.description AS "lineDesc",
                pr.currency, pr.estimated_total::float8 AS "estimatedTotal", pr.needed_by AS "neededBy", pr.requested_by_name AS "requestedByName"
         FROM purchase_request pr LEFT JOIN project p ON p.id=pr.project_id LEFT JOIN budget_line bl ON bl.id=pr.budget_line_id
         WHERE pr.org_id=$1 ORDER BY pr.created_at DESC`, [orgId]
      );
      title = "purchase-requests";
      header = ["Number", "Title", "Status", "Project", "Budget line", "Currency", "Estimated total", "Needed by", "Requested by"];
      rows = r.map((x) => [x.number, x.title, x.status, x.projectCode ?? "", x.lineCode ? `${x.lineCode} — ${x.lineDesc ?? ""}` : "", x.currency, x.estimatedTotal, d(x.neededBy), x.requestedByName ?? ""]);
      break;
    }
    case "bills": {
      const b = await q<{ number: string; vendor: string | null; poNumber: string | null; billDate: unknown; dueDate: unknown; status: string; currency: string; total: number; amountPaid: number }>(
        `SELECT b.number, v.name AS vendor, po.number AS "poNumber", b.bill_date AS "billDate", b.due_date AS "dueDate", b.status,
                b.currency, b.total::float8 AS total, b.amount_paid::float8 AS "amountPaid"
         FROM vendor_bill b LEFT JOIN vendor v ON v.id=b.vendor_id LEFT JOIN purchase_order po ON po.id=b.po_id
         WHERE b.org_id=$1 ORDER BY b.created_at DESC`, [orgId]
      );
      title = "vendor-bills";
      header = ["Number", "Vendor", "PO", "Bill date", "Due date", "Status", "Currency", "Total", "Paid", "Outstanding"];
      rows = b.map((x) => [x.number, x.vendor ?? "", x.poNumber ?? "", d(x.billDate), d(x.dueDate), x.status, x.currency, x.total, x.amountPaid, Math.round((x.total - x.amountPaid) * 100) / 100]);
      break;
    }
    case "orders": {
      const o = await q<{ number: string; vendor: string | null; projectCode: string | null; orderDate: unknown; status: string; currency: string; total: number }>(
        `SELECT po.number, v.name AS vendor, p.code AS "projectCode", po.order_date AS "orderDate", po.status, po.currency, po.total::float8 AS total
         FROM purchase_order po LEFT JOIN vendor v ON v.id=po.vendor_id LEFT JOIN project p ON p.id=po.project_id
         WHERE po.org_id=$1 ORDER BY po.created_at DESC`, [orgId]
      );
      title = "purchase-orders";
      header = ["Number", "Vendor", "Project", "Order date", "Status", "Currency", "Total"];
      rows = o.map((x) => [x.number, x.vendor ?? "", x.projectCode ?? "", d(x.orderDate), x.status, x.currency, x.total]);
      break;
    }
    case "vendor-template":
    case "contract-template": {
      const ent = scope.replace("-template", "");
      const spec = importEntity(ent);
      if (!spec) return new Response("Unknown template", { status: 404 });
      title = `${ent}-template`;
      header = spec.fields.map((f) => f.label);
      const EXAMPLE: Record<string, Cell[]> = {
        vendor: ["Acme Scientific Ltd", "Jane Doe", "sales@acme.example", "+256700000000", "1001234567", "0123456789", "Plot 5, Kampala Road"],
        contract: ["CTR/2026/001", "Supply of laboratory reagents", "Acme Scientific Ltd", 25000, "USD", "2026-01-01", "2026-12-31", "active", "Quarterly supply of consumables"],
      };
      rows = [EXAMPLE[ent] ?? spec.fields.map(() => "")];
      break;
    }
    default:
      return new Response("Unknown export", { status: 404 });
  }

  return sheetResponse(fmt, `${slug}-${title}`, title, header, rows);
}
