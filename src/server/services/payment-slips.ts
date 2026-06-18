import "server-only";
import { randomBytes } from "crypto";
import { q, one } from "@/server/db";

export function newSignToken(): string {
  return randomBytes(24).toString("hex");
}

export type SlipRow = {
  id: string; number: string; title: string; category: string | null; slipDate: string;
  currency: string; status: string; project: string | null;
  payees: number; total: number; signed: number;
  financeSignedAt: string | null; piSignedAt: string | null;
};

export async function listSlips(orgId: string): Promise<SlipRow[]> {
  return q<SlipRow>(
    `SELECT s.id, s.number, s.title, s.category, s.slip_date AS "slipDate", s.currency, s.status,
            p.code AS project, s.finance_signed_at AS "financeSignedAt", s.pi_signed_at AS "piSignedAt",
            COUNT(pp.id)::int AS payees, COALESCE(SUM(pp.amount),0)::float AS total,
            COUNT(pp.id) FILTER (WHERE pp.signed)::int AS signed
       FROM payment_slip s
       LEFT JOIN project p ON p.id=s.project_id
       LEFT JOIN payment_slip_payee pp ON pp.slip_id=s.id
      WHERE s.org_id=$1
      GROUP BY s.id, p.code
      ORDER BY s.slip_date DESC NULLS LAST, s.created_at DESC LIMIT 200`, [orgId]
  );
}

export type SlipHeader = {
  id: string; orgId: string; number: string; title: string; category: string | null; slipDate: string;
  currency: string; status: string; note: string | null; project: string | null; projectId: string | null;
  preparedByName: string | null;
  financeSignedName: string | null; financeSignature: string | null; financeSignedAt: string | null;
  piSignedName: string | null; piSignature: string | null; piSignedAt: string | null;
};

export async function getSlip(id: string, orgId: string): Promise<SlipHeader | null> {
  return one<SlipHeader>(
    `SELECT s.id, s.org_id AS "orgId", s.number, s.title, s.category, s.slip_date AS "slipDate",
            s.currency, s.status, s.note, s.project_id AS "projectId", p.code AS project,
            s.prepared_by_name AS "preparedByName",
            s.finance_signed_name AS "financeSignedName", s.finance_signature AS "financeSignature", s.finance_signed_at AS "financeSignedAt",
            s.pi_signed_name AS "piSignedName", s.pi_signature AS "piSignature", s.pi_signed_at AS "piSignedAt"
       FROM payment_slip s LEFT JOIN project p ON p.id=s.project_id
      WHERE s.id=$1 AND s.org_id=$2`, [id, orgId]
  );
}

export type PayeeRow = {
  id: string; idx: number; name: string; phone: string | null; email: string | null;
  designation: string | null; paymentFor: string | null; amount: number;
  signToken: string | null; signed: boolean; signature: string | null; signedName: string | null;
  signedAt: string | null; linkSentAt: string | null;
};

export async function getPayees(slipId: string): Promise<PayeeRow[]> {
  return q<PayeeRow>(
    `SELECT id, idx, name, phone, email, designation, payment_for AS "paymentFor", amount::float,
            sign_token AS "signToken", signed, signature, signed_name AS "signedName",
            signed_at AS "signedAt", link_sent_at AS "linkSentAt"
       FROM payment_slip_payee WHERE slip_id=$1 ORDER BY idx, created_at`, [slipId]
  );
}

// For the public (no-login) signing page: resolve a token to its payee + slip +
// letterhead, so the signer sees exactly what they are signing for.
export async function getPayeeByToken(token: string): Promise<{
  payee: PayeeRow; slip: SlipHeader;
  org: { name: string; logoDataUrl: string | null; address: string | null };
} | null> {
  const payee = await one<PayeeRow & { slipId: string }>(
    `SELECT id, idx, name, phone, email, designation, payment_for AS "paymentFor", amount::float,
            sign_token AS "signToken", signed, signature, signed_name AS "signedName",
            signed_at AS "signedAt", link_sent_at AS "linkSentAt", slip_id AS "slipId"
       FROM payment_slip_payee WHERE sign_token=$1`, [token]
  );
  if (!payee) return null;
  const slip = await one<SlipHeader & { orgId: string }>(
    `SELECT s.id, s.org_id AS "orgId", s.number, s.title, s.category, s.slip_date AS "slipDate",
            s.currency, s.status, s.note, s.project_id AS "projectId", p.code AS project,
            s.prepared_by_name AS "preparedByName",
            s.finance_signed_name AS "financeSignedName", s.finance_signature AS "financeSignature", s.finance_signed_at AS "financeSignedAt",
            s.pi_signed_name AS "piSignedName", s.pi_signature AS "piSignature", s.pi_signed_at AS "piSignedAt"
       FROM payment_slip s LEFT JOIN project p ON p.id=s.project_id WHERE s.id=$1`, [payee.slipId]
  );
  if (!slip) return null;
  const org = await one<{ name: string; logoDataUrl: string | null; address: string | null }>(
    `SELECT name, logo_data_url AS "logoDataUrl", address FROM organization WHERE id=$1`, [slip.orgId]
  );
  return { payee, slip, org: org ?? { name: "", logoDataUrl: null, address: null } };
}
