"use client";
import { useState } from "react";
import { uploadAndParseAction } from "@/app/actions";

const SAMPLE = `Project Title: Climate-Resilient Smallholder Agriculture in the Rift Valley
Donor: Global Climate Fund

Objective 1: Increase climate resilience of 5,000 smallholder households by 2026
Objective 2: Strengthen local agricultural extension systems

Output 1.1: Drought-tolerant seed distributed to target households
Output 2.1: Extension officers trained and equipped

Activity 1.1: Conduct baseline household survey
Activity 1.2: Procure and distribute certified drought-tolerant seed
Activity 2.1: Deliver training of trainers for extension officers

Budget
Baseline survey enumerators ......... 18,000
Certified seed procurement .......... 120,000
Training of trainers workshop ....... 35,000`;

export function ImportForm({ projectId, projectCurrency = "USD" }: { projectId: string; projectCurrency?: string }) {
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [docType, setDocType] = useState("proposal");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [pending, setPending] = useState(false);
  const CCY = ["UGX", "USD", "EUR", "GBP", "KES", "TZS", "RWF", "NGN", "ZAR"];

  return (
    <form action={uploadAndParseAction} onSubmit={() => setPending(true)} className="card p-6 space-y-4">
      <input type="hidden" name="projectId" value={projectId} />

      <div className="flex gap-2 text-sm">
        <button type="button" onClick={() => setMode("file")}
          className={mode === "file" ? "btn btn-primary btn-sm" : "btn btn-sm"}>Upload a file</button>
        <button type="button" onClick={() => setMode("paste")}
          className={mode === "paste" ? "btn btn-primary btn-sm" : "btn btn-sm"}>Paste text</button>
      </div>

      <label className="block">
        <span className="label">Document type</span>
        <select name="docType" className="select" value={docType} onChange={(e) => setDocType(e.target.value)}>
          <option value="proposal">Proposal / narrative</option>
          <option value="workplan">Work plan</option>
          <option value="budget">Budget (spreadsheet)</option>
          <option value="sow">Statement of work</option>
        </select>
      </label>

      {docType === "budget" && (
        <label className="block">
          <span className="label">Budget currency</span>
          <select name="currency" className="select" defaultValue={projectCurrency}>
            <option value="">Auto-detect from file</option>
            {CCY.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <span className="text-xs mt-1 block" style={{ color: "var(--muted)" }}>
            The currency this budget file is written in. Set it before uploading so the figures
            import under the right currency — the amounts are taken as-is, not converted.
          </span>
        </label>
      )}

      {mode === "file" ? (
        <label className="block">
          <span className="label">Choose a file from your computer</span>
          <input type="file" name="file"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
            className="input" />
          <span className="text-xs mt-1 block" style={{ color: "var(--muted)" }}>
            Supports PDF, Word (.docx/.doc), Excel (.xlsx/.xls), CSV and text. {fileName && <strong>{fileName}</strong>}
          </span>
        </label>
      ) : (
        <label className="block">
          <span className="label">Paste document text</span>
          <textarea name="text" rows={12} className="textarea font-mono text-xs"
            placeholder="Paste the contents of your proposal, work plan or budget here…"
            value={text} onChange={(e) => setText(e.target.value)} />
          <button type="button" className="btn btn-sm mt-2" onClick={() => setText(SAMPLE)}>Load sample proposal</button>
        </label>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Parsing…" : "Upload & parse"}
        </button>
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          Extracts objectives, outputs, activities and budget lines for your review. Uploaded files are saved to project Documents.
        </span>
      </div>
    </form>
  );
}
