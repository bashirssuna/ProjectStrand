import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { financeAuditTrail, complianceFlags, changeSummary, type AuditFilters } from "@/server/services/finance_audit";

export async function GET(req: Request) {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) return new Response("Forbidden", { status: 403 });

  const url = new URL(req.url);
  const filters: AuditFilters = {
    entity: url.searchParams.get("entity"),
    projectId: url.searchParams.get("project"),
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
  };
  const projCode = filters.projectId ? (await one<{ code: string }>(`SELECT code FROM project WHERE id=$1 AND org_id=$2`, [filters.projectId, org.id]))?.code : null;
  const flags = await complianceFlags(org.id);
  const trail = await financeAuditTrail(org.id, filters, 10000);

  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  // Sheet 1 — audit trail
  const trailRows: (string | number)[][] = [["When", "Who", "Action", "Transaction type", "Reference", "Project", "Details"]];
  for (const e of trail) {
    trailRows.push([
      fmtDateTime(e.createdAt), e.actor ?? "", label(e.action), label(e.entity),
      e.entityId ?? "", e.projectCode ?? "", changeSummary(e.before, e.after),
    ]);
  }
  const ws1 = XLSX.utils.aoa_to_sheet(trailRows);
  ws1["!cols"] = [{ wch: 20 }, { wch: 18 }, { wch: 12 }, { wch: 18 }, { wch: 22 }, { wch: 14 }, { wch: 48 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Audit trail");

  // Sheet 2 — control checks
  const flagRows: (string | number)[][] = [["Severity", "Check", "Finding", "Project", "When"]];
  for (const f of flags) flagRows.push([f.severity, label(f.rule), f.message, f.projectCode, fmtDateTime(f.createdAt)]);
  const ws2 = XLSX.utils.aoa_to_sheet(flagRows);
  ws2["!cols"] = [{ wch: 10 }, { wch: 18 }, { wch: 56 }, { wch: 14 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Control checks");

  const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `audit-trail${projCode ? `-${projCode}` : ""}-${stamp}.xlsx`;
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
