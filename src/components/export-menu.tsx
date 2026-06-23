// Download menu for a register: offers CSV or Excel (.xlsx) of the current data.
// Uses a native <details> disclosure (no client JS) and links to the export API,
// which streams the file with a Content-Disposition attachment header.
export function ExportMenu({ scope, query, label = "Export" }: { scope: string; query?: Record<string, string | undefined>; label?: string }) {
  const params = new URLSearchParams();
  if (query) for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
  const extra = params.toString();
  const href = (fmt: string) => `/api/export/${scope}?format=${fmt}${extra ? `&${extra}` : ""}`;
  const itemStyle = { display: "block", padding: "6px 12px", fontSize: 13, borderRadius: 6, color: "var(--fg)", textDecoration: "none", whiteSpace: "nowrap" as const };
  return (
    <details className="export-menu no-print" style={{ position: "relative", display: "inline-block" }}>
      <summary className="btn btn-sm" style={{ listStyle: "none", cursor: "pointer" }}>{label} ▾</summary>
      <div style={{ position: "absolute", right: 0, marginTop: 4, zIndex: 20, minWidth: 150, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "var(--shadow)", padding: 4 }}>
        <a href={href("xlsx")} style={itemStyle} className="hover:underline">Excel (.xlsx)</a>
        <a href={href("csv")} style={itemStyle} className="hover:underline">CSV (.csv)</a>
      </div>
    </details>
  );
}
