import { requirePortalEmployee } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { fmtDate, dateInput } from "@/lib/format";
import { label } from "@/lib/enums";
import { updateMyProfileAction, uploadMyDocumentAction, deleteMyDocumentAction } from "@/app/actions";

export default async function MyProfile({ searchParams }: { searchParams: Promise<{ saved?: string; uploaded?: string; err?: string }> }) {
  const { employeeId } = await requirePortalEmployee();
  const sp = await searchParams;
  const e = (await one<{
    firstName: string; lastName: string; email: string | null; phone: string | null; jobTitle: string | null;
    department: string | null; address: string | null; dateOfBirth: string | null; nationalId: string | null;
    emergencyContact: string | null; cvSummary: string | null; qualifications: string | null; skills: string | null;
  }>(
    `SELECT first_name AS "firstName", last_name AS "lastName", email, phone, job_title AS "jobTitle", department,
            address, date_of_birth AS "dateOfBirth", national_id AS "nationalId", emergency_contact AS "emergencyContact",
            cv_summary AS "cvSummary", qualifications, skills FROM employee WHERE id=$1`, [employeeId]
  ))!;
  const docs = await q<{ id: string; name: string; docType: string; createdAt: string }>(
    `SELECT id, name, doc_type AS "docType", created_at AS "createdAt" FROM employee_document WHERE employee_id=$1 ORDER BY created_at DESC`, [employeeId]
  );

  return (
    <div className="max-w-4xl">
      <PageHeader title="My profile & CV" subtitle={`${e.firstName} ${e.lastName}${e.jobTitle ? ` · ${e.jobTitle}` : ""}${e.department ? ` · ${e.department}` : ""}`} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Profile saved.</div>}
      {sp.uploaded && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Document uploaded.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Please choose a file.</div>}

      <SectionTitle>Personal details</SectionTitle>
      <form action={updateMyProfileAction} className="card p-4 grid sm:grid-cols-3 gap-3 mb-6">
        <Field label="Phone"><input name="phone" defaultValue={e.phone ?? ""} className="input" /></Field>
        <Field label="Date of birth"><input type="date" name="dateOfBirth" defaultValue={dateInput(e.dateOfBirth)} className="input" /></Field>
        <Field label="National ID"><input name="nationalId" defaultValue={e.nationalId ?? ""} className="input" /></Field>
        <div className="sm:col-span-3"><Field label="Address"><input name="address" defaultValue={e.address ?? ""} className="input" /></Field></div>
        <div className="sm:col-span-3"><Field label="Emergency contact"><input name="emergencyContact" defaultValue={e.emergencyContact ?? ""} className="input" /></Field></div>
        <div className="sm:col-span-3"><Field label="Professional summary (CV)"><textarea name="cvSummary" rows={3} defaultValue={e.cvSummary ?? ""} className="textarea" /></Field></div>
        <div className="sm:col-span-3"><Field label="Qualifications"><textarea name="qualifications" rows={2} defaultValue={e.qualifications ?? ""} className="textarea" placeholder="Degrees, certifications…" /></Field></div>
        <div className="sm:col-span-3"><Field label="Skills"><input name="skills" defaultValue={e.skills ?? ""} className="input" placeholder="Comma-separated" /></Field></div>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Save profile</button></div>
      </form>

      <SectionTitle>My documents</SectionTitle>
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Your CV, certificates and personal documents. Only you and HR can see these — they are never mixed with project documents.</p>
      {docs.length === 0 ? <Empty title="No documents yet" hint="Upload your CV and certificates below." /> : (
        <div className="card overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Document</th><th className="th text-left">Type</th><th className="th text-left">Uploaded</th><th className="th" /></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="td"><a href={`/api/employee-files/${d.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>📎 {d.name}</a></td>
                  <td className="td"><Badge tone="muted">{label(d.docType)}</Badge></td>
                  <td className="td">{fmtDate(d.createdAt)}</td>
                  <td className="td text-right"><form action={deleteMyDocumentAction}><input type="hidden" name="documentId" value={d.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button></form></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form action={uploadMyDocumentAction} className="card p-4 flex flex-wrap items-end gap-3">
        <Field label="Document"><input type="file" name="file" required className="input" /></Field>
        <Field label="Type">
          <select name="docType" className="select"><option value="cv">CV / Résumé</option><option value="certificate">Certificate</option><option value="id">ID document</option><option value="contract">Contract</option><option value="other">Other</option></select>
        </Field>
        <button className="btn btn-primary" type="submit">Upload</button>
      </form>
    </div>
  );
}
