import "server-only";

export type ExtractResult = { text: string; rows: (string | number | Date)[][] | null };

// Extracts plain text (and, for spreadsheets, raw rows) from an uploaded file.
// Supported: .docx .pdf .xlsx .xls .csv .txt .md  (.doc legacy = best effort)
export async function extractFile(fileName: string, buf: Buffer): Promise<ExtractResult> {
  const ext = (fileName.toLowerCase().split(".").pop() || "").trim();

  if (ext === "docx") {
    const mammoth = (await import("mammoth")).default;
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { text: value, rows: null };
  }

  if (ext === "pdf") {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return { text: Array.isArray(text) ? text.join("\n") : text, rows: null };
  }

  if (ext === "xlsx" || ext === "xls" || ext === "csv") {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
    const firstSheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<(string | number | Date)[]>(firstSheet, {
      header: 1, blankrows: false, defval: "",
    });
    // also produce a readable text fallback so the narrative parser can run
    const text = rows.map((r) => r.filter((c) => c !== "").map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c)).join("  ")).join("\n");
    return { text, rows };
  }

  if (ext === "doc") {
    // legacy binary .doc: strip readable ASCII runs as a best effort
    const ascii = buf.toString("latin1").replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, " ").replace(/\s{2,}/g, " ").trim();
    return { text: ascii, rows: null };
  }

  // txt, md, anything else: treat as UTF-8 text
  return { text: buf.toString("utf8"), rows: null };
}
