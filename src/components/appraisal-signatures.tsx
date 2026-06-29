import { signAppraisalAction } from "@/app/actions";
import { fmtDate } from "@/lib/format";
import type { AppraisalDetail } from "@/server/services/appraisals";

type Caps = { employee?: boolean; appraiser?: boolean; hr?: boolean };

// Three sign-off blocks (appraisee, appraiser, Director HR) — Section G of the form.
// `caps` enables the Sign button per role; print view passes none (read-only).
export function AppraisalSignatures({ a, caps = {}, returnTo, readOnly }: { a: AppraisalDetail; caps?: Caps; returnTo?: "portal"; readOnly?: boolean }) {
  const block = (role: "employee" | "appraiser" | "hr", title: string, sig: string | null, at: string | null, name: string | null, can: boolean | undefined) => (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, minHeight: 96 }} className="flex flex-col">
      <div className="text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>{title}</div>
      <div className="flex-1 flex items-end">
        {sig ? <img src={sig} alt="signature" style={{ maxHeight: 46, maxWidth: "100%", objectFit: "contain" }} />
          : <span className="text-xs" style={{ color: "var(--muted)" }}>{readOnly ? "—" : "Not signed"}</span>}
      </div>
      <div className="mt-1 pt-1 text-xs" style={{ borderTop: "1px solid var(--border)", color: "var(--fg)" }}>
        {name ? <span>{name}</span> : <span style={{ color: "var(--muted)" }}>Signature &amp; date</span>}
        {at && <span style={{ color: "var(--muted)" }}> · {fmtDate(at)}</span>}
      </div>
      {!readOnly && can && !at && (
        <form action={signAppraisalAction} className="mt-2 no-print">
          <input type="hidden" name="appraisalId" value={a.id} />
          <input type="hidden" name="role" value={role} />
          {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
          <button className="btn btn-sm" type="submit">Sign as {title.toLowerCase()}</button>
        </form>
      )}
    </div>
  );
  return (
    <div className="grid sm:grid-cols-3 gap-3">
      {block("employee", "Appraisee", a.employeeSignature, a.employeeSignedAt, a.employeeSignedName, caps.employee)}
      {block("appraiser", "Appraiser", a.appraiserSignature, a.appraiserSignedAt, a.appraiserSignedName, caps.appraiser)}
      {block("hr", "Director, HR", a.hrSignature, a.hrSignedAt, a.hrSignedName, caps.hr)}
    </div>
  );
}
