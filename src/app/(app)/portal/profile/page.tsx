import { requirePortalEmployee } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { fmtDate, dateInput } from "@/lib/format";
import { label } from "@/lib/enums";
import { SignaturePad } from "@/components/signature-pad";
import { updateMyProfileAction, uploadMyDocumentAction, deleteMyDocumentAction, uploadAvatarAction, changePasswordAction } from "@/app/actions";

export default async function MyProfile({ searchParams }: { searchParams: Promise<{ saved?: string; uploaded?: string; err?: string; avatar?: string; pw?: string }> }) {
  const { employeeId, name } = await requirePortalEmployee();
  const sp = await searchParams;
  const e = (await one<{
    firstName: string; lastName: string; email: string | null; alternativeEmail: string | null; phone: string | null; jobTitle: string | null;
    department: string | null; address: string | null; dateOfBirth: string | null; nationalId: string | null;
    emergencyContact: string | null; cvSummary: string | null; qualifications: string | null; skills: string | null;
    gender: string | null; maritalStatus: string | null; nationality: string | null; nssfNumber: string | null; tinNumber: string | null;
    nextOfKin: string | null; nextOfKinRelationship: string | null; nextOfKinPhone: string | null; nextOfKinAddress: string | null;
  }>(
    `SELECT first_name AS "firstName", last_name AS "lastName", email, alternative_email AS "alternativeEmail", phone, job_title AS "jobTitle", department,
            address, date_of_birth AS "dateOfBirth", national_id AS "nationalId", emergency_contact AS "emergencyContact",
            cv_summary AS "cvSummary", qualifications, skills, gender, marital_status AS "maritalStatus", nationality,
            nssf_number AS "nssfNumber", tin_number AS "tinNumber", next_of_kin AS "nextOfKin",
            next_of_kin_relationship AS "nextOfKinRelationship", next_of_kin_phone AS "nextOfKinPhone", next_of_kin_address AS "nextOfKinAddress"
     FROM employee WHERE id=$1`, [employeeId]
  ))!;
  const avatar = (await one<{ url: string | null }>(`SELECT up.avatar_url AS url FROM employee e LEFT JOIN user_profile up ON up.user_id=e.user_id WHERE e.id=$1`, [employeeId]))?.url ?? null;
  const sig = (await one<{ dataUrl: string | null }>(`SELECT sa.data_url AS "dataUrl" FROM employee e JOIN signature_asset sa ON sa.user_id=e.user_id WHERE e.id=$1 ORDER BY sa.created_at DESC LIMIT 1`, [employeeId]))?.dataUrl ?? null;
  const docs = await q<{ id: string; name: string; docType: string; createdAt: string }>(
    `SELECT id, name, doc_type AS "docType", created_at AS "createdAt" FROM employee_document WHERE employee_id=$1 ORDER BY created_at DESC`, [employeeId]
  );

  return (
    <div className="max-w-4xl">
      <PageHeader title="My profile & CV" subtitle={`${e.firstName} ${e.lastName}${e.jobTitle ? ` · ${e.jobTitle}` : ""}${e.department ? ` · ${e.department}` : ""}`} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Profile saved.</div>}
      {sp.uploaded && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Document uploaded.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Please choose a file.</div>}

      {/* Profile photo */}
      <SectionTitle>Profile photo</SectionTitle>
      <div className="card p-4 mb-6">
        {sp.avatar === "ok" && <p className="text-sm mb-2" style={{ color: "var(--ok)" }}>Photo updated.</p>}
        {sp.avatar === "type" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>Please choose an image file.</p>}
        {sp.avatar === "size" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>Image must be under 2 MB.</p>}
        <div className="flex items-center gap-4">
          <div style={{ width: 72, height: 72, borderRadius: "50%", overflow: "hidden", background: "var(--surface)", border: "1px solid var(--border)", display: "grid", placeItems: "center" }}>
            {avatar
              ? <img src={avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : <span className="font-display text-2xl" style={{ color: "var(--muted)" }}>{name.slice(0, 1).toUpperCase()}</span>}
          </div>
          <form action={uploadAvatarAction} className="flex items-end gap-2">
            <input type="hidden" name="back" value="/portal/profile" />
            <Field label="Upload a photo (max 2 MB)"><input type="file" name="file" accept="image/*" required className="input" /></Field>
            <button className="btn btn-primary" type="submit">Upload</button>
          </form>
        </div>
      </div>

      <SectionTitle>Personal &amp; contact details</SectionTitle>
      <form action={updateMyProfileAction} className="card p-4 grid sm:grid-cols-3 gap-3 mb-6">
        <Field label="Primary email (managed by HR)"><input value={e.email ?? ""} disabled className="input" style={{ opacity: 0.7 }} /></Field>
        <div className="sm:col-span-2"><Field label="Alternative / personal email"><input name="alternativeEmail" type="email" defaultValue={e.alternativeEmail ?? ""} className="input" placeholder="you@personal.com" /></Field></div>
        <Field label="Phone"><input name="phone" defaultValue={e.phone ?? ""} className="input" /></Field>
        <Field label="Gender"><select name="gender" defaultValue={e.gender ?? ""} className="select"><option value="">—</option><option>Female</option><option>Male</option><option>Other</option><option>Prefer not to say</option></select></Field>
        <Field label="Marital status"><select name="maritalStatus" defaultValue={e.maritalStatus ?? ""} className="select"><option value="">—</option><option>Single</option><option>Married</option><option>Divorced</option><option>Widowed</option></select></Field>
        <Field label="Date of birth"><input type="date" name="dateOfBirth" defaultValue={dateInput(e.dateOfBirth)} className="input" /></Field>
        <Field label="Nationality"><input name="nationality" defaultValue={e.nationality ?? ""} className="input" /></Field>
        <Field label="National ID"><input name="nationalId" defaultValue={e.nationalId ?? ""} className="input" /></Field>
        <Field label="NSSF number"><input name="nssfNumber" defaultValue={e.nssfNumber ?? ""} className="input" /></Field>
        <Field label="TIN (tax) number"><input name="tinNumber" defaultValue={e.tinNumber ?? ""} className="input" /></Field>
        <div className="sm:col-span-3"><Field label="Residence / address"><input name="address" defaultValue={e.address ?? ""} className="input" /></Field></div>

        <div className="sm:col-span-3 pt-2 border-t" style={{ borderColor: "var(--border)" }}><div className="label">Next of kin</div></div>
        <Field label="Next of kin name"><input name="nextOfKin" defaultValue={e.nextOfKin ?? ""} className="input" /></Field>
        <Field label="Relationship"><input name="nextOfKinRelationship" defaultValue={e.nextOfKinRelationship ?? ""} className="input" /></Field>
        <Field label="NoK phone"><input name="nextOfKinPhone" defaultValue={e.nextOfKinPhone ?? ""} className="input" /></Field>
        <div className="sm:col-span-3"><Field label="NoK address"><input name="nextOfKinAddress" defaultValue={e.nextOfKinAddress ?? ""} className="input" /></Field></div>
        <div className="sm:col-span-3"><Field label="Emergency contact"><input name="emergencyContact" defaultValue={e.emergencyContact ?? ""} className="input" /></Field></div>

        <div className="sm:col-span-3 pt-2 border-t" style={{ borderColor: "var(--border)" }}><div className="label">Professional</div></div>
        <div className="sm:col-span-3"><Field label="Professional summary (CV)"><textarea name="cvSummary" rows={3} defaultValue={e.cvSummary ?? ""} className="textarea" /></Field></div>
        <div className="sm:col-span-3"><Field label="Qualifications"><textarea name="qualifications" rows={2} defaultValue={e.qualifications ?? ""} className="textarea" placeholder="Degrees, certifications…" /></Field></div>
        <div className="sm:col-span-3"><Field label="Skills"><input name="skills" defaultValue={e.skills ?? ""} className="input" placeholder="Comma-separated" /></Field></div>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Save profile</button></div>
      </form>

      {/* Signature */}
      <SectionTitle>Signature</SectionTitle>
      <div className="card p-4 mb-6">
        <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Used on approvals and forms that need your sign-off. Drawn signatures are stored as an image.</p>
        <SignaturePad existing={sig} back="/portal/profile" />
      </div>

      {/* Change password */}
      <SectionTitle>Change password</SectionTitle>
      <div className="card p-4 mb-6">
        {sp.pw === "ok" && <p className="text-sm mb-2" style={{ color: "var(--ok)" }}>Password updated.</p>}
        {sp.pw === "wrong" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>Your current password is incorrect.</p>}
        {sp.pw === "match" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>The new passwords don&apos;t match.</p>}
        {sp.pw && !["ok", "wrong", "match"].includes(sp.pw) && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>{sp.pw}</p>}
        <form action={changePasswordAction} className="grid sm:grid-cols-3 gap-3 items-end">
          <input type="hidden" name="back" value="/portal/profile" />
          <Field label="Current password"><input type="password" name="currentPassword" required className="input" /></Field>
          <Field label="New password"><input type="password" name="newPassword" required minLength={8} className="input" /></Field>
          <Field label="Confirm new password"><input type="password" name="confirmPassword" required minLength={8} className="input" /></Field>
          <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs" style={{ color: "var(--muted)" }}>At least 8 characters, with one capital letter and one special character.</span>
            <button className="btn btn-primary" type="submit">Update password</button>
          </div>
        </form>
      </div>

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
