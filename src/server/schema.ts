// AUTO-GENERATED from schema.sql. Do not edit by hand.
export const SCHEMA_SQL = String.raw`-- Project Strand schema (Postgres / PGlite). Mirrors prisma/schema.prisma.
-- JSON-ish columns are text (parsed in app) for a single mental model.

CREATE TABLE IF NOT EXISTS organization (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  logo_url text,
  brand_color text NOT NULL DEFAULT '#2f5d62',
  default_mode text NOT NULL DEFAULT 'advanced',
  plan text NOT NULL DEFAULT 'trial',
  trial_ends_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_user (
  id text PRIMARY KEY,
  email text UNIQUE NOT NULL,
  name text NOT NULL,
  password_hash text,
  status text NOT NULL DEFAULT 'active',
  is_super_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_profile (
  id text PRIMARY KEY,
  user_id text UNIQUE NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  title text, phone text, avatar_url text, bio text,
  timezone text NOT NULL DEFAULT 'Africa/Nairobi',
  notify_prefs text NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS role (
  id text PRIMARY KEY,
  org_id text REFERENCES organization(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  permissions text NOT NULL DEFAULT '[]',
  UNIQUE (org_id, key)
);

CREATE TABLE IF NOT EXISTS org_membership (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_id text REFERENCES role(id),
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS project (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  code text NOT NULL,
  title text NOT NULL,
  summary text,
  status text NOT NULL DEFAULT 'draft',
  mode text NOT NULL DEFAULT 'advanced',
  donor text, funding_source text, grant_number text,
  currency text NOT NULL DEFAULT 'USD',
  start_date timestamptz, end_date timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS project_member (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role text NOT NULL,
  permissions text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS folder (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  parent_id text
);

CREATE TABLE IF NOT EXISTS project_document (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  folder_id text REFERENCES folder(id),
  name text NOT NULL,
  doc_type text NOT NULL DEFAULT 'other',
  mime_type text,
  storage_key text,
  size_bytes integer NOT NULL DEFAULT 0,
  extracted_text text,
  tags text NOT NULL DEFAULT '[]',
  linked_entity text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_version (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES project_document(id) ON DELETE CASCADE,
  version integer NOT NULL,
  storage_key text, note text, created_by_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sow (
  id text PRIMARY KEY,
  project_id text UNIQUE NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  approved_by_id text, approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sow_section (
  id text PRIMARY KEY,
  sow_id text NOT NULL REFERENCES sow(id) ON DELETE CASCADE,
  key text NOT NULL, title text NOT NULL,
  content text NOT NULL DEFAULT '',
  "order" integer NOT NULL DEFAULT 0,
  source_ref text
);

CREATE TABLE IF NOT EXISTS sow_version (
  id text PRIMARY KEY,
  sow_id text NOT NULL REFERENCES sow(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot text NOT NULL,
  created_by_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS objective (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  level text NOT NULL DEFAULT 'objective',
  code text NOT NULL, statement text NOT NULL, narrative text,
  "order" integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS output (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  objective_id text REFERENCES objective(id),
  code text NOT NULL, statement text NOT NULL,
  "order" integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS indicator (
  id text PRIMARY KEY,
  objective_id text REFERENCES objective(id) ON DELETE CASCADE,
  output_id text REFERENCES output(id),
  name text NOT NULL,
  baseline double precision NOT NULL DEFAULT 0,
  target double precision NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'count',
  means_of_verification text, assumptions text
);

CREATE TABLE IF NOT EXISTS indicator_actual (
  id text PRIMARY KEY,
  indicator_id text NOT NULL REFERENCES indicator(id) ON DELETE CASCADE,
  period text NOT NULL,
  value double precision NOT NULL,
  note text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  output_id text REFERENCES output(id),
  parent_id text,
  code text, title text NOT NULL,
  type text NOT NULL DEFAULT 'activity',
  owner_id text,
  status text NOT NULL DEFAULT 'not_started',
  progress integer NOT NULL DEFAULT 0,
  start_date timestamptz, end_date timestamptz,
  recurrence text,
  "order" integer NOT NULL DEFAULT 0,
  budget_line_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task (
  id text PRIMARY KEY,
  activity_id text NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
  title text NOT NULL, owner_id text,
  status text NOT NULL DEFAULT 'not_started',
  due_date timestamptz, done boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS dependency (
  id text PRIMARY KEY,
  from_id text NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
  to_id text NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'FS',
  UNIQUE (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS timeline_baseline (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL, snapshot text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS budget (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'donor',
  currency text NOT NULL DEFAULT 'USD',
  period_type text NOT NULL DEFAULT 'quarter',
  status text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS budget_period (
  id text PRIMARY KEY,
  budget_id text NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  label text NOT NULL, start_date timestamptz NOT NULL, end_date timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_category (
  id text PRIMARY KEY,
  budget_id text NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  name text NOT NULL,
  cost_type text NOT NULL DEFAULT 'direct'
);

CREATE TABLE IF NOT EXISTS budget_line (
  id text PRIMARY KEY,
  budget_id text NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  category_id text REFERENCES budget_category(id),
  code text NOT NULL, description text NOT NULL,
  unit text NOT NULL DEFAULT 'unit',
  unit_cost double precision NOT NULL DEFAULT 0,
  quantity double precision NOT NULL DEFAULT 1,
  planned double precision NOT NULL DEFAULT 0,
  justification text, activity_area text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only history of budget line changes. budget_line_id is plain text (no
-- FK) so the trail survives even after a line is edited or deleted, letting a PI
-- see what a line (e.g. "sensitisation") used to be and who changed it.
CREATE TABLE IF NOT EXISTS budget_line_revision (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  budget_line_id text NOT NULL,
  code text NOT NULL,
  description text NOT NULL,
  unit_cost double precision NOT NULL DEFAULT 0,
  quantity double precision NOT NULL DEFAULT 1,
  planned double precision NOT NULL DEFAULT 0,
  action text NOT NULL DEFAULT 'updated',
  changed_by text,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blr_line ON budget_line_revision(budget_line_id);
CREATE INDEX IF NOT EXISTS idx_blr_project ON budget_line_revision(project_id);

CREATE TABLE IF NOT EXISTS expenditure (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  budget_line_id text NOT NULL REFERENCES budget_line(id),
  requisition_id text,
  amount double precision NOT NULL,
  date timestamptz NOT NULL,
  reference text, payee text, note text,
  approved boolean NOT NULL DEFAULT false,
  created_by_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commitment (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  budget_line_id text NOT NULL REFERENCES budget_line(id),
  amount double precision NOT NULL,
  date timestamptz NOT NULL, note text
);

CREATE TABLE IF NOT EXISTS requisition (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  number text NOT NULL, title text NOT NULL,
  activity_id text REFERENCES activity(id),
  activity_label text,
  budget_line_id text REFERENCES budget_line(id),
  amount double precision NOT NULL,
  justification text, needed_by timestamptz, payee text,
  requested_by_id text,
  status text NOT NULL DEFAULT 'draft',
  disbursed_amount double precision NOT NULL DEFAULT 0,
  disbursement_ref text, retirement_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requisition_item (
  id text PRIMARY KEY,
  requisition_id text NOT NULL REFERENCES requisition(id) ON DELETE CASCADE,
  description text NOT NULL,
  unit_cost double precision NOT NULL DEFAULT 0,
  quantity double precision NOT NULL DEFAULT 1,
  amount double precision NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requisition_approval (
  id text PRIMARY KEY,
  requisition_id text NOT NULL REFERENCES requisition(id) ON DELETE CASCADE,
  step integer NOT NULL,
  role text NOT NULL,
  approver_id text,
  decision text NOT NULL DEFAULT 'pending',
  comment text, signature_id text, decided_at timestamptz
);

CREATE TABLE IF NOT EXISTS approval_matrix (
  id text PRIMARY KEY,
  org_id text REFERENCES organization(id) ON DELETE CASCADE,
  project_id text REFERENCES project(id) ON DELETE CASCADE,
  doc_type text NOT NULL DEFAULT 'requisition',
  steps text NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS signature_asset (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  storage_key text, data_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'monthly',
  title text NOT NULL, period_label text,
  status text NOT NULL DEFAULT 'draft',
  generated_by_ai boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_section (
  id text PRIMARY KEY,
  report_id text NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  key text NOT NULL, title text NOT NULL,
  content text NOT NULL DEFAULT '',
  "order" integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meeting (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title text NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  location text, meeting_url text, agenda text,
  attendees text NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS calendar_event (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'deadline',
  starts_at timestamptz NOT NULL, ends_at timestamptz, ref_entity text
);

CREATE TABLE IF NOT EXISTS reminder (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  title text NOT NULL, due_at timestamptz NOT NULL,
  sent boolean NOT NULL DEFAULT false, ref_entity text
);

CREATE TABLE IF NOT EXISTS notification (
  id text PRIMARY KEY,
  org_id text REFERENCES organization(id),
  user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  type text NOT NULL, title text NOT NULL, body text, link text,
  read boolean NOT NULL DEFAULT false,
  email_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id text PRIMARY KEY,
  org_id text REFERENCES organization(id),
  user_id text REFERENCES app_user(id),
  action text NOT NULL, entity text NOT NULL, entity_id text,
  before text, after text, meta text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_issue (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'risk',
  title text NOT NULL, detail text,
  severity text NOT NULL DEFAULT 'medium',
  likelihood text NOT NULL DEFAULT 'medium',
  status text NOT NULL DEFAULT 'open',
  owner_id text
);

CREATE TABLE IF NOT EXISTS comment (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  activity_id text REFERENCES activity(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS anomaly_flag (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  rule text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  message text NOT NULL, entity text,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS extraction_job (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  doc_type text NOT NULL DEFAULT 'unknown',
  status text NOT NULL DEFAULT 'parsed',
  raw_text text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parsing_suggestion (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES extraction_job(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload text NOT NULL,
  confidence double precision NOT NULL DEFAULT 0.7,
  accepted boolean NOT NULL DEFAULT false,
  source_ref text
);

-- Backfill columns for databases created before this column existed.
ALTER TABLE requisition ADD COLUMN IF NOT EXISTS activity_label text;

CREATE INDEX IF NOT EXISTS idx_project_org ON project(org_id);
CREATE INDEX IF NOT EXISTS idx_member_project ON project_member(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id);
CREATE INDEX IF NOT EXISTS idx_budgetline_budget ON budget_line(budget_id);
CREATE INDEX IF NOT EXISTS idx_exp_line ON expenditure(budget_line_id);
CREATE INDEX IF NOT EXISTS idx_req_project ON requisition(project_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_project ON anomaly_flag(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id);

-- Password setup / recovery tokens (for invitations and "forgot password")
CREATE TABLE IF NOT EXISTS password_token (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_user(id),
  token text NOT NULL UNIQUE,
  purpose text NOT NULL DEFAULT 'reset',
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_token_token ON password_token(token);

-- SaaS / billing columns (idempotent for upgrades)
ALTER TABLE organization ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'trial';
ALTER TABLE organization ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- One requisition can cover several activities (one budget line, many activities).
CREATE TABLE IF NOT EXISTS requisition_activity (
  id text PRIMARY KEY,
  requisition_id text NOT NULL REFERENCES requisition(id) ON DELETE CASCADE,
  activity_id text NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
  UNIQUE (requisition_id, activity_id)
);
CREATE INDEX IF NOT EXISTS idx_reqact_req ON requisition_activity(requisition_id);

-- Supporting documents attached to a requisition (quotes, invoices, approvals).
CREATE TABLE IF NOT EXISTS requisition_attachment (
  id text PRIMARY KEY,
  requisition_id text NOT NULL REFERENCES requisition(id) ON DELETE CASCADE,
  name text NOT NULL,
  storage_key text,
  mime_type text,
  size_bytes integer,
  uploaded_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Payment vouchers: actual disbursement against an approved requisition.
-- One voucher per payee, so a requisition can be paid out to several
-- individuals/institutions, and partial funding is the sum of vouchers.
CREATE TABLE IF NOT EXISTS payment_voucher (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  requisition_id text NOT NULL REFERENCES requisition(id) ON DELETE CASCADE,
  number text NOT NULL,
  payee text NOT NULL,
  amount double precision NOT NULL DEFAULT 0,
  method text NOT NULL DEFAULT 'bank_transfer',
  reference text,
  purpose text,
  prepared_by text,
  prepared_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pv_req ON payment_voucher(requisition_id);

-- Evidence files proving an activity was completed (reports, photos…).
CREATE TABLE IF NOT EXISTS activity_evidence (
  id text PRIMARY KEY,
  activity_id text NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES project_document(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Risk/issue closure evidence + lessons learnt.
ALTER TABLE risk_issue ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE risk_issue ADD COLUMN IF NOT EXISTS lessons text;
ALTER TABLE risk_issue ADD COLUMN IF NOT EXISTS evidence_document_id text;

-- Voucher approval workflow: Prepared by → Checked by → Approved by.
-- Payment is only "made" (counts toward disbursement) once status='approved'.
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'prepared';
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS checked_by text;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS checked_by_name text;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS checked_at timestamptz;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS approved_by_name text;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- ===========================================================================
-- GENERAL LEDGER (institutional accounting foundation)
-- Double-entry: every financial event posts a balanced journal entry whose
-- lines sum to zero (sum of debits = sum of credits). Entries are append-only;
-- corrections are made by posting a reversing entry, never by editing/deleting.
-- This is the backbone for institution-wide financial statements that roll up
-- across all projects.
-- ===========================================================================

-- Chart of accounts: the master list of accounts an institution posts against.
-- account_type drives which financial statement a balance lands on.
CREATE TABLE IF NOT EXISTS ledger_account (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  code text NOT NULL,                  -- e.g. '1000', '4100', '5200'
  name text NOT NULL,                  -- e.g. 'Cash at bank', 'Grant income — NIH'
  account_type text NOT NULL,          -- asset | liability | equity | income | expense
  normal_side text NOT NULL,           -- debit | credit (which side increases it)
  parent_code text,                    -- for grouping/subtotals (nullable)
  is_active boolean NOT NULL DEFAULT true,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);
CREATE INDEX IF NOT EXISTS idx_ledger_account_org ON ledger_account(org_id);

-- Fiscal periods: months can be locked so nothing posts to a closed period.
CREATE TABLE IF NOT EXISTS fiscal_period (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  label text NOT NULL,                 -- 'YYYY-MM'
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'open', -- open | closed
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, label)
);

-- Journal entry header. One per financial event. source_type/source_id give
-- traceability back to the originating record (expenditure, voucher, manual…).
CREATE TABLE IF NOT EXISTS journal_entry (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  entry_no text NOT NULL,              -- 'JE-000001' per org
  entry_date date NOT NULL,
  memo text,
  source_type text NOT NULL DEFAULT 'manual', -- manual | expenditure | voucher | reversal
  source_id text,                      -- id of the originating record
  project_id text,                     -- optional project attribution
  reverses_entry_id text,              -- if this entry reverses another
  posted_by text,
  posted_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, entry_no)
);
CREATE INDEX IF NOT EXISTS idx_journal_entry_org ON journal_entry(org_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_source ON journal_entry(source_type, source_id);

-- Journal lines: the debits and credits. Per entry these MUST sum to zero.
-- Amounts are stored in minor units would be ideal, but to stay consistent with
-- the existing schema we use numeric for exactness (not floating point).
CREATE TABLE IF NOT EXISTS journal_line (
  id text PRIMARY KEY,
  entry_id text NOT NULL REFERENCES journal_entry(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES ledger_account(id),
  project_id text,                     -- cost attribution per line
  debit numeric(18,2) NOT NULL DEFAULT 0,
  credit numeric(18,2) NOT NULL DEFAULT 0,
  description text
);
CREATE INDEX IF NOT EXISTS idx_journal_line_entry ON journal_line(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_line_account ON journal_line(account_id);

-- Maps project expenditure/voucher postings to the right ledger accounts.
-- When set, expenditures debit the expense account and credit cash/payables.
CREATE TABLE IF NOT EXISTS gl_posting_rule (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  rule_key text NOT NULL,              -- 'expenditure' | 'voucher_cash' | 'voucher_bank'
  debit_account_id text,
  credit_account_id text,
  UNIQUE (org_id, rule_key)
);

-- ===========================================================================
-- FINANCE MODULE EXPANSION: invoicing, receipts, assets, bank rec, FX
-- All money events post to the general ledger (journal_entry/journal_line).
-- ===========================================================================

-- Exchange rates: 1 unit of the foreign currency equals 'rate' units of base.
CREATE TABLE IF NOT EXISTS exchange_rate (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  currency text NOT NULL,              -- e.g. 'USD', 'EUR'
  base_currency text NOT NULL,         -- the org's reporting currency, e.g. 'UGX'
  rate numeric(18,6) NOT NULL,         -- multiply foreign amount by this to get base
  as_of date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fx_org ON exchange_rate(org_id, currency, as_of);

-- Org-level base/reporting currency.
ALTER TABLE organization ADD COLUMN IF NOT EXISTS base_currency text NOT NULL DEFAULT 'USD';

-- Customers / funders we invoice.
CREATE TABLE IF NOT EXISTS finance_customer (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text, phone text, address text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sales/grant invoices (income we expect to receive).
CREATE TABLE IF NOT EXISTS invoice (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text,
  customer_id text REFERENCES finance_customer(id),
  number text NOT NULL,                -- 'INV-0001' per org
  invoice_date date NOT NULL,
  due_date date,
  currency text NOT NULL DEFAULT 'USD',
  income_account_id text REFERENCES ledger_account(id),
  description text,
  status text NOT NULL DEFAULT 'draft', -- draft | issued | part_paid | paid | void
  total numeric(18,2) NOT NULL DEFAULT 0,
  amount_paid numeric(18,2) NOT NULL DEFAULT 0,
  journal_entry_id text,               -- the AR posting when issued
  created_by text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE TABLE IF NOT EXISTS invoice_line (
  id text PRIMARY KEY,
  invoice_id text NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity numeric(18,2) NOT NULL DEFAULT 1,
  unit_price numeric(18,2) NOT NULL DEFAULT 0,
  amount numeric(18,2) NOT NULL DEFAULT 0
);

-- Receipts: money actually received (clears an invoice / posts income).
CREATE TABLE IF NOT EXISTS receipt (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text,
  invoice_id text REFERENCES invoice(id),
  customer_id text REFERENCES finance_customer(id),
  number text NOT NULL,                -- 'RCT-0001' per org
  receipt_date date NOT NULL,
  amount numeric(18,2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  method text NOT NULL DEFAULT 'bank_transfer',
  reference text, note text,
  deposit_account_id text REFERENCES ledger_account(id), -- cash/bank debited
  income_account_id text REFERENCES ledger_account(id),  -- used for direct (no-invoice) receipts
  journal_entry_id text,
  reconciled boolean NOT NULL DEFAULT false,
  created_by text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

-- Fixed-asset register, with straight-line depreciation.
CREATE TABLE IF NOT EXISTS fixed_asset (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text,
  tag text,                            -- asset tag / serial
  name text NOT NULL,
  category text,
  acquired_on date NOT NULL,
  cost numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  useful_life_months integer NOT NULL DEFAULT 36,
  salvage_value numeric(18,2) NOT NULL DEFAULT 0,
  asset_account_id text REFERENCES ledger_account(id),
  expense_account_id text REFERENCES ledger_account(id), -- depreciation expense
  accumulated_depreciation numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active', -- active | disposed
  location text, custodian text, note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS depreciation_run (
  id text PRIMARY KEY,
  asset_id text NOT NULL REFERENCES fixed_asset(id) ON DELETE CASCADE,
  period_label text NOT NULL,          -- 'YYYY-MM'
  amount numeric(18,2) NOT NULL,
  journal_entry_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, period_label)
);

-- Bank statement lines for reconciliation against a cash/bank ledger account.
CREATE TABLE IF NOT EXISTS bank_statement_line (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES ledger_account(id), -- the bank GL account
  txn_date date NOT NULL,
  description text,
  amount numeric(18,2) NOT NULL,       -- +receipts / -payments as on the statement
  matched_entry_id text,               -- the journal_entry it reconciles to
  reconciled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bank_line_acct ON bank_statement_line(account_id);

-- ===========================================================================
-- HUMAN RESOURCES MODULE
-- Employees are standalone records, optionally linked to a login (app_user).
-- Payroll deductions are configurable rules (flat or % of basic/gross), so no
-- tax rates are hard-coded — the institution defines PAYE/NSSF/etc. themselves.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS employee (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id text REFERENCES app_user(id) ON DELETE SET NULL, -- optional login link
  staff_no text,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text, phone text,
  job_title text, department text,
  -- employment details
  contract_type text NOT NULL DEFAULT 'permanent', -- permanent | fixed_term | casual | consultant | intern
  start_date date, end_date date,
  basic_salary numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  pay_frequency text NOT NULL DEFAULT 'monthly', -- monthly | weekly | daily
  -- bank / payment
  bank_name text, bank_account text, bank_branch text, mobile_money text,
  -- leave
  annual_leave_days numeric(6,1) NOT NULL DEFAULT 21,
  status text NOT NULL DEFAULT 'active', -- active | on_leave | terminated
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_org ON employee(org_id);

-- Recurring salary components (allowances that add, deductions that subtract).
-- amount_type: 'flat' = fixed amount; 'percent' = % of basis.
CREATE TABLE IF NOT EXISTS pay_component (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,                  -- 'PAYE', 'NSSF (employee)', 'Housing allowance'
  kind text NOT NULL,                  -- earning | deduction
  amount_type text NOT NULL DEFAULT 'flat', -- flat | percent
  rate numeric(18,4) NOT NULL DEFAULT 0,    -- flat amount OR percentage (e.g. 5 = 5%)
  basis text NOT NULL DEFAULT 'basic',      -- basic | gross  (what percent is applied to)
  applies_default boolean NOT NULL DEFAULT true, -- auto-apply to all employees on a run
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-employee overrides/assignments of components (optional; defaults used if absent).
CREATE TABLE IF NOT EXISTS employee_pay_component (
  id text PRIMARY KEY,
  employee_id text NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  component_id text NOT NULL REFERENCES pay_component(id) ON DELETE CASCADE,
  override_rate numeric(18,4),
  UNIQUE (employee_id, component_id)
);

-- Leave requests with balance tracking.
CREATE TABLE IF NOT EXISTS leave_request (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  employee_id text NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  leave_type text NOT NULL DEFAULT 'annual', -- annual | sick | unpaid | maternity | other
  start_date date NOT NULL,
  end_date date NOT NULL,
  days numeric(6,1) NOT NULL DEFAULT 0,
  reason text,
  status text NOT NULL DEFAULT 'pending', -- pending | approved | rejected | cancelled
  decided_by text, decided_by_name text, decided_at timestamptz, decision_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Timesheets: hours/days an employee logs, optionally against a project.
CREATE TABLE IF NOT EXISTS timesheet (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  employee_id text NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  project_id text,
  work_date date NOT NULL,
  hours numeric(6,2) NOT NULL DEFAULT 0,
  description text,
  status text NOT NULL DEFAULT 'submitted', -- submitted | approved | rejected
  approved_by text, approved_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Payroll runs (a batch for a period) and the resulting payslips.
CREATE TABLE IF NOT EXISTS payroll_run (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  period_label text NOT NULL,          -- 'YYYY-MM'
  run_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft', -- draft | finalised
  note text,
  total_gross numeric(18,2) NOT NULL DEFAULT 0,
  total_deductions numeric(18,2) NOT NULL DEFAULT 0,
  total_net numeric(18,2) NOT NULL DEFAULT 0,
  journal_entry_id text,
  created_by text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period_label)
);
CREATE TABLE IF NOT EXISTS payslip (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES payroll_run(id) ON DELETE CASCADE,
  employee_id text NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  basic numeric(18,2) NOT NULL DEFAULT 0,
  earnings numeric(18,2) NOT NULL DEFAULT 0,   -- sum of allowances
  gross numeric(18,2) NOT NULL DEFAULT 0,
  deductions numeric(18,2) NOT NULL DEFAULT 0,
  net numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Line-level breakdown on each payslip (for the slip + statutory reporting).
CREATE TABLE IF NOT EXISTS payslip_line (
  id text PRIMARY KEY,
  payslip_id text NOT NULL REFERENCES payslip(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,                  -- earning | deduction
  amount numeric(18,2) NOT NULL DEFAULT 0
);

-- ===========================================================================
-- PROCUREMENT MODULE (its own flow: vendors → PR → PO → GRN → bill)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS vendor (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  contact_person text, email text, phone text, address text,
  tax_id text, bank_account text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Purchase requests: what someone wants to buy, with its own approval.
CREATE TABLE IF NOT EXISTS purchase_request (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text,
  number text NOT NULL,                -- 'PR-0001'
  title text NOT NULL,
  justification text,
  needed_by date,
  currency text NOT NULL DEFAULT 'USD',
  estimated_total numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft', -- draft | submitted | approved | rejected | ordered | closed
  requested_by text, requested_by_name text,
  decided_by text, decided_by_name text, decided_at timestamptz, decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE TABLE IF NOT EXISTS purchase_request_item (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES purchase_request(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity numeric(18,2) NOT NULL DEFAULT 1,
  unit text,
  estimated_unit_cost numeric(18,2) NOT NULL DEFAULT 0,
  amount numeric(18,2) NOT NULL DEFAULT 0
);

-- Purchase orders: an approved order placed with a vendor.
CREATE TABLE IF NOT EXISTS purchase_order (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text,
  request_id text REFERENCES purchase_request(id),
  vendor_id text REFERENCES vendor(id),
  number text NOT NULL,                -- 'PO-0001'
  order_date date NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  total numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open', -- open | partially_received | received | billed | cancelled
  note text,
  created_by text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE TABLE IF NOT EXISTS purchase_order_item (
  id text PRIMARY KEY,
  po_id text NOT NULL REFERENCES purchase_order(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity numeric(18,2) NOT NULL DEFAULT 1,
  unit text,
  unit_cost numeric(18,2) NOT NULL DEFAULT 0,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  qty_received numeric(18,2) NOT NULL DEFAULT 0
);

-- Goods Received Notes: records receipt of items against a PO.
CREATE TABLE IF NOT EXISTS goods_received_note (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  po_id text NOT NULL REFERENCES purchase_order(id) ON DELETE CASCADE,
  number text NOT NULL,                -- 'GRN-0001'
  received_date date NOT NULL,
  received_by text, received_by_name text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE TABLE IF NOT EXISTS grn_item (
  id text PRIMARY KEY,
  grn_id text NOT NULL REFERENCES goods_received_note(id) ON DELETE CASCADE,
  po_item_id text NOT NULL REFERENCES purchase_order_item(id) ON DELETE CASCADE,
  qty_received numeric(18,2) NOT NULL DEFAULT 0,
  condition_note text
);

-- Vendor bills (the payable raised from a PO / GRN).
CREATE TABLE IF NOT EXISTS vendor_bill (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text,
  po_id text REFERENCES purchase_order(id),
  vendor_id text REFERENCES vendor(id),
  number text NOT NULL,                -- 'BILL-0001'
  bill_date date NOT NULL,
  due_date date,
  currency text NOT NULL DEFAULT 'USD',
  total numeric(18,2) NOT NULL DEFAULT 0,
  amount_paid numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'unpaid', -- unpaid | part_paid | paid | void
  expense_account_id text REFERENCES ledger_account(id),
  journal_entry_id text,
  note text,
  created_by text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
`;
