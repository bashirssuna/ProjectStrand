import "server-only";

// Helpers that turn a header + rows grid into a downloadable CSV or Excel file.
// Used by the /api/export routes. The XLSX path reuses the same `xlsx` library
// already in the stack for spreadsheet *parsing*, here for generation.

export type Cell = string | number | null | undefined;

function csvEscape(v: Cell): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvResponse(filename: string, header: string[], rows: Cell[][]): Response {
  const all = [header, ...rows];
  // Leading BOM so Excel opens UTF-8 correctly (accents, currency symbols).
  const csv = "\uFEFF" + all.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.csv"`,
    },
  });
}

export async function xlsxResponse(filename: string, sheetName: string, header: string[], rows: Cell[][]): Promise<Response> {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  // Auto-fit column widths from the longest cell in each column.
  ws["!cols"] = header.map((h, i) => {
    let max = String(h).length;
    for (const r of rows) { const len = r[i] == null ? 0 : String(r[i]).length; if (len > max) max = len; }
    return { wch: Math.min(60, Math.max(8, max + 2)) };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31) || "Sheet1");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}.xlsx"`,
    },
  });
}

// Single entry point used by routes — picks the format from the query string.
export async function sheetResponse(format: string | null, filename: string, sheetName: string, header: string[], rows: Cell[][]): Promise<Response> {
  return format === "csv" ? csvResponse(filename, header, rows) : xlsxResponse(filename, sheetName, header, rows);
}
