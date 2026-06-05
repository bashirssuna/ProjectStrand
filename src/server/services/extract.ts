import "server-only";

export type ExtractResult = { text: string; rows: (string | number | Date)[][] | null };

// Extracts plain text (and, for spreadsheets, raw rows) from an uploaded file.
// Supported: .docx .pdf .xlsx .xls .csv .txt .md  (.doc legacy = best effort)
export async function extractFile(fileName: string, buf: Buffer): Promise<ExtractResult> {
  const ext = (fileName.toLowerCase().split(".").pop() || "").trim();

  if (ext === "docx") {
    const mammoth = (await import("mammoth")).default;
    const { value } = await mammoth.extractRawText({ buffer: buf });
    let rows: (string | number | Date)[][] | null = null;
    try { rows = await extractDocxBestTable(buf); } catch { rows = null; }
    return { text: value, rows };
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

// Reads tables from a .docx (which mammoth's raw-text extraction drops) and
// returns the most "tabular" one as a grid. Gantt charts mark months by cell
// SHADING rather than text, so a shaded-but-empty cell is emitted as "X" — that
// lets the work-plan parser detect a month span and derive start/end dates.
async function extractDocxBestTable(buf: Buffer): Promise<(string | number | Date)[][] | null> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return null;

  const tables = xml.match(/<w:tbl[\s>][\s\S]*?<\/w:tbl>/g) || [];
  let best: (string | number | Date)[][] | null = null;
  let bestScore = 0;

  for (const tb of tables) {
    const trs = tb.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || [];
    const grid: string[][] = [];
    for (const tr of trs) {
      const tcs = tr.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) || [];
      const cells: string[] = [];
      for (const tc of tcs) {
        const text = tc.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        const shd = tc.match(/<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/);
        const fill = shd ? shd[1].toUpperCase() : "";
        const shaded = !!fill && fill !== "FFFFFF" && fill !== "AUTO";
        cells.push(text || (shaded ? "X" : ""));
      }
      if (cells.length) grid.push(cells);
    }
    if (grid.length < 2) continue;

    const headerText = grid[0].join(" ").toLowerCase();
    const looksWorkplan = /activit|task|deliverable|work\s*package|milestone|budget|line|cost|description/.test(headerText);
    const monthish = grid[0].filter((c) => /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|m\s*\d+|month\s*\d+|q[1-4])/i.test(c)).length;
    const score = (looksWorkplan ? 100 : 0) + monthish * 5 + grid.length;
    if (score > bestScore) { bestScore = score; best = grid; }
  }
  return best;
}
