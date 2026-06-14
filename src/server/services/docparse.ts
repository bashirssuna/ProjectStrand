import "server-only";
import mammoth from "mammoth";

// Pull a clean list of duties from an uploaded Word document (an employee
// contract, ToR, or scope-of-work). Strategy: if the document has a
// "Responsibilities / Duties / Scope of work / Tasks" heading, take the lines
// under it; otherwise fall back to any bullet/numbered lines in the document.
// Returns a de-duplicated, trimmed list — never auto-finalised, always editable.
export async function extractResponsibilities(buf: Buffer): Promise<string[]> {
  let text = "";
  try {
    const res = await mammoth.extractRawText({ buffer: buf });
    text = res.value || "";
  } catch {
    return [];
  }
  const rawLines = text.split(/\r?\n/).map((l) => l.trim());

  const headingRe = /\b(responsibilit|duties|scope of work|key tasks|main tasks|role and responsibilit|terms of reference|deliverables|objectives of the (assignment|role))/i;
  const stopHeadingRe = /^(\d+\.?\s+)?[A-Z][A-Za-z ]{2,40}:?\s*$/; // a short title-like line
  const bulletRe = /^([-*•▪◦–·]|\d+[.)]|\([a-z0-9]+\)|[a-z]\))\s+/i;

  const clean = (s: string) => s.replace(bulletRe, "").replace(/[;.\s]+$/, "").trim();

  let collected: string[] = [];

  // 1) Section-based extraction.
  const headingIdx = rawLines.findIndex((l) => l && headingRe.test(l) && l.length < 80);
  if (headingIdx >= 0) {
    let blanks = 0;
    for (let i = headingIdx + 1; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (!line) { blanks++; if (blanks >= 2 && collected.length) break; continue; }
      blanks = 0;
      // Stop if we hit another major heading (and we already have items).
      if (collected.length >= 2 && stopHeadingRe.test(line) && !bulletRe.test(line) && headingRe.test(line) === false && line.length < 50) break;
      const c = clean(line);
      if (c.length >= 3) collected.push(c);
      if (collected.length >= 40) break;
    }
  }

  // 2) Fallback: bullet/numbered lines anywhere.
  if (collected.length < 2) {
    collected = rawLines.filter((l) => bulletRe.test(l)).map(clean).filter((l) => l.length >= 3);
  }

  // De-duplicate (case-insensitive), cap length and count.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of collected) {
    const trimmed = item.slice(0, 300);
    const k = trimmed.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(trimmed);
    if (out.length >= 30) break;
  }
  return out;
}
