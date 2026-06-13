import { can } from "@/server/policy";
import { getFinancialStatements, statementToCsv } from "@/server/services/financials";

// CSV export of a financial statement: /api/financials/{projectId}?statement=variance|revexp|balance|cashflow
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await can(id, "project.view"))) return new Response("Forbidden", { status: 403 });
  const which = new URL(req.url).searchParams.get("statement") || "variance";
  const fs = await getFinancialStatements(id);
  const csv = statementToCsv(fs, which);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fs.projectCode}-${which}.csv"`,
    },
  });
}
