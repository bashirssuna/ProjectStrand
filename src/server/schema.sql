-- Project Strand schema (Postgres / PGlite). Mirrors prisma/schema.prisma.
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
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE activity ADD COLUMN IF NOT EXISTS completed_at timestamptz;

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

-- Documents can be archived (soft-hidden) by document managers without deleting.
ALTER TABLE project_document ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

-- Budget lines support a third costing factor (e.g. No. of people × Rate/day × No.
-- of days), matching standard donor budget templates. frequency defaults to 1 so
-- existing lines keep planned = unit_cost × quantity.
ALTER TABLE budget_line ADD COLUMN IF NOT EXISTS frequency double precision NOT NULL DEFAULT 1;
ALTER TABLE budget_line_revision ADD COLUMN IF NOT EXISTS frequency double precision NOT NULL DEFAULT 1;

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
ALTER TABLE journal_line ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE journal_line ADD COLUMN IF NOT EXISTS fx_amount numeric(18,2);
ALTER TABLE journal_line ADD COLUMN IF NOT EXISTS fx_rate numeric(18,6);
CREATE INDEX IF NOT EXISTS idx_journal_line_ccy ON journal_line(currency);

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
  base_currency text NOT NULL,         -- the org's reporting currency, set per-org (e.g. USD, KES, NGN, EUR)
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

-- ===========================================================================
-- DEPARTMENTS + EMPLOYEE SELF-SERVICE
-- ===========================================================================
-- A restricted self-service login flag. Staff logins can fill timesheets/leave/
-- purchase requests, see limited project tabs, and manage only their own docs.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS is_staff boolean NOT NULL DEFAULT false;

-- Departments are real records staff are assigned to.
CREATE TABLE IF NOT EXISTS department (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  head_employee_id text,               -- optional department head
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- ===================== Recruitment / Applicant Tracking (ATS) =====================
-- A vacancy being recruited for (carries the job description).
CREATE TABLE IF NOT EXISTS job_opening (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  reference text,
  title text NOT NULL,
  department_id text REFERENCES department(id) ON DELETE SET NULL,
  department text,
  project_id text REFERENCES project(id) ON DELETE SET NULL,
  employment_type text NOT NULL DEFAULT 'full_time', -- full_time | part_time | fixed_term | contract | internship | consultant
  location text,
  positions integer NOT NULL DEFAULT 1,
  description text,            -- role summary / JD
  responsibilities text,
  requirements text,          -- qualifications & requirements
  salary_min numeric(18,2),
  salary_max numeric(18,2),
  currency text,
  hiring_manager text,
  status text NOT NULL DEFAULT 'open',  -- draft | open | on_hold | closed | filled | cancelled
  opened_date date,
  closing_date date,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_opening_org ON job_opening(org_id);

-- A person in the talent pool (reusable across openings).
CREATE TABLE IF NOT EXISTS candidate (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  email text, phone text,
  gender text,                -- optional, for fair-recruitment reporting
  location text,
  current_title text, current_employer text,
  highest_qualification text,
  years_experience numeric(5,1),
  source text,                -- advert | referral | headhunt | walk_in | direct
  cv_key text, cv_name text,  -- uploaded CV (storage key + original name)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_candidate_org ON candidate(org_id);

-- A candidate's application to one opening; the `stage` is the pipeline position.
CREATE TABLE IF NOT EXISTS job_application (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  opening_id text NOT NULL REFERENCES job_opening(id) ON DELETE CASCADE,
  candidate_id text NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'applied', -- applied | screening | shortlisted | interview | offer | hired | rejected | withdrawn
  applied_date date,
  cover_note text,
  rejection_reason text,
  rejected_stage text,
  hired_employee_id text REFERENCES employee(id) ON DELETE SET NULL,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opening_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_job_application_opening ON job_application(opening_id);

CREATE TABLE IF NOT EXISTS interview (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  application_id text NOT NULL REFERENCES job_application(id) ON DELETE CASCADE,
  round integer NOT NULL DEFAULT 1,
  kind text NOT NULL DEFAULT 'panel',    -- phone_screen | technical | panel | final
  mode text NOT NULL DEFAULT 'in_person', -- in_person | video | phone
  scheduled_at timestamptz,
  location text,
  status text NOT NULL DEFAULT 'scheduled', -- scheduled | completed | cancelled | no_show
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_interview_application ON interview(application_id);

-- One panelist's scorecard for an interview (evaluation matrix + COI declaration).
CREATE TABLE IF NOT EXISTS interview_score (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  interview_id text NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
  panelist text NOT NULL,
  technical numeric(4,1),      -- 1-5
  experience numeric(4,1),     -- 1-5
  communication numeric(4,1),  -- 1-5
  motivation numeric(4,1),     -- 1-5 (motivation / culture fit)
  recommendation text,         -- recommend | maybe | do_not_recommend
  coi_declared boolean NOT NULL DEFAULT false, -- panelist conflict-of-interest declared
  comments text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_interview_score_interview ON interview_score(interview_id);

CREATE TABLE IF NOT EXISTS job_offer (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  application_id text NOT NULL REFERENCES job_application(id) ON DELETE CASCADE,
  salary numeric(18,2),
  currency text,
  employment_type text,
  start_date date,
  status text NOT NULL DEFAULT 'draft', -- draft | sent | accepted | declined | withdrawn
  offer_date date,
  response_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_offer_application ON job_offer(application_id);

-- ===================== Performance Appraisals =====================
-- An org-wide review period (annual, mid-year, probation, quarterly).
CREATE TABLE IF NOT EXISTS appraisal_cycle (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'annual',   -- annual | mid_year | probation | quarterly
  period_start date, period_end date,
  due_date date,
  rating_max integer NOT NULL DEFAULT 5,
  status text NOT NULL DEFAULT 'open',    -- draft | open | closed
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appraisal_cycle_org ON appraisal_cycle(org_id);

-- One employee's appraisal within a cycle; `status` is the review workflow.
CREATE TABLE IF NOT EXISTS appraisal (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  cycle_id text NOT NULL REFERENCES appraisal_cycle(id) ON DELETE CASCADE,
  employee_id text NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  appraiser_employee_id text REFERENCES employee(id) ON DELETE SET NULL,
  appraiser_name text,
  status text NOT NULL DEFAULT 'draft',   -- draft | self_assessment | manager_review | completed | acknowledged
  overall_rating numeric(4,1),
  manager_comments text,
  employee_comments text,
  development_plan text,                   -- growth / training needs
  hr_comments text,                        -- Director HR comments (Section G)
  archived boolean NOT NULL DEFAULT false,
  employee_signed_at timestamptz, employee_signature text, employee_signed_name text,
  appraiser_signed_at timestamptz, appraiser_signature text, appraiser_signed_name text,
  hr_signed_at timestamptz, hr_signature text, hr_signed_name text,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_appraisal_cycle ON appraisal(cycle_id);

-- A scored objective or competency within an appraisal (self + manager rated).
CREATE TABLE IF NOT EXISTS appraisal_item (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  appraisal_id text NOT NULL REFERENCES appraisal(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'objective',  -- objective | competency
  title text NOT NULL,
  description text,
  weight numeric(5,1),                     -- optional weighting %
  target text,                             -- objective target
  result text,                             -- objective result / evidence
  self_rating numeric(4,1), self_comment text,
  manager_rating numeric(4,1), manager_comment text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appraisal_item_appraisal ON appraisal_item(appraisal_id);

-- additive columns for appraisal sign-off / archive (existing installs)
ALTER TABLE appraisal ADD COLUMN IF NOT EXISTS hr_comments text;
ALTER TABLE appraisal ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE appraisal ADD COLUMN IF NOT EXISTS employee_signed_at timestamptz;
ALTER TABLE appraisal ADD COLUMN IF NOT EXISTS employee_signature text;
ALTER TABLE appraisal ADD COLUMN IF NOT EXISTS employee_signed_name text;
ALTER TABLE appraisal ADD COLUMN IF NOT EXISTS appraiser_signed_at timestamptz;
ALTER TABLE appraisal ADD COLUMN IF NOT EXISTS appraiser_signature text;
ALTER TABLE appraisal ADD COLUMN IF NOT EXISTS appraiser_signed_name text;
ALTER TABLE appraisal ADD COLUMN IF NOT EXISTS hr_signed_at timestamptz;
ALTER TABLE appraisal ADD COLUMN IF NOT EXISTS hr_signature text;
ALTER TABLE appraisal ADD COLUMN IF NOT EXISTS hr_signed_name text;

-- ===================== Employee Relations (Grievance & Disciplinary) =====================
-- A grievance (raised by an employee) or disciplinary case (raised against one).
-- `employee_id` is the complainant for grievances, the respondent for disciplinary.
CREATE TABLE IF NOT EXISTS er_case (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  case_no text,
  type text NOT NULL,                        -- grievance | disciplinary
  employee_id text REFERENCES employee(id) ON DELETE SET NULL,
  counterparty text,                         -- respondent (grievance) / reporter (disciplinary)
  category text,
  title text NOT NULL,
  description text,
  severity text NOT NULL DEFAULT 'medium',   -- low | medium | high
  confidential boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open',        -- type-specific workflow stage
  outcome text,
  outcome_notes text,
  assigned_to text,                          -- handler / investigator
  opened_date date,
  due_date date,
  closed_date date,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_er_case_org ON er_case(org_id);

-- Timeline entry on a case: note, investigation step, hearing, notice, decision, appeal.
CREATE TABLE IF NOT EXISTS er_case_event (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  case_id text NOT NULL REFERENCES er_case(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'note',         -- note | investigation | hearing | notice | decision | appeal | status_change
  summary text,
  detail text,
  event_date date,
  author text,
  file_key text, file_name text,             -- optional attachment (evidence, notice, minutes)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_er_case_event_case ON er_case_event(case_id);

-- ===================== Onboarding / Exit Checklists =====================
-- Reusable checklist templates (induction, exit clearance, handover) and
-- per-employee instances instantiated from them, with item-level check-off.
CREATE TABLE IF NOT EXISTS checklist_template (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'onboarding',   -- onboarding | exit | handover
  name text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checklist_template_org ON checklist_template(org_id);

CREATE TABLE IF NOT EXISTS checklist_template_item (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  template_id text NOT NULL REFERENCES checklist_template(id) ON DELETE CASCADE,
  category text,                             -- Pre-arrival | First day | IT | Finance | Stores | HR ...
  title text NOT NULL,
  description text,
  assignee_role text,                        -- HR | Line Manager | IT | Finance | Employee ...
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checklist_template_item_tpl ON checklist_template_item(template_id);

CREATE TABLE IF NOT EXISTS checklist_instance (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  employee_id text REFERENCES employee(id) ON DELETE SET NULL,
  template_id text REFERENCES checklist_template(id) ON DELETE SET NULL,
  type text NOT NULL DEFAULT 'onboarding',
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open',        -- open | completed
  started_date date,
  due_date date,
  completed_date date,
  notes text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checklist_instance_org ON checklist_instance(org_id);

CREATE TABLE IF NOT EXISTS checklist_instance_item (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  instance_id text NOT NULL REFERENCES checklist_instance(id) ON DELETE CASCADE,
  category text,
  title text NOT NULL,
  description text,
  assignee text,
  status text NOT NULL DEFAULT 'pending',     -- pending | done | na
  done_by text, done_at timestamptz,
  due_date date,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checklist_instance_item_inst ON checklist_instance_item(instance_id);

-- ===================== Petty Cash / Imprest =====================
-- A petty-cash float held by a custodian on the imprest system: disbursements
-- draw the cash down, replenishments restore it toward the float limit.
CREATE TABLE IF NOT EXISTS petty_cash_account (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  custodian text,                                  -- person holding the float
  custodian_employee_id text REFERENCES employee(id) ON DELETE SET NULL,
  project_id text REFERENCES project(id) ON DELETE SET NULL,
  currency text NOT NULL DEFAULT 'USD',
  float_limit numeric(16,2) NOT NULL DEFAULT 0,    -- imprest ceiling
  status text NOT NULL DEFAULT 'active',            -- active | closed
  opened_date date,
  notes text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_petty_cash_account_org ON petty_cash_account(org_id);
ALTER TABLE petty_cash_account ADD COLUMN IF NOT EXISTS project_id text REFERENCES project(id) ON DELETE SET NULL;

-- Ledger entry. amount is positive for top_up/expense; adjustment carries its own
-- sign. Effect on cash = (expense ? -amount : amount).
CREATE TABLE IF NOT EXISTS petty_cash_txn (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES petty_cash_account(id) ON DELETE CASCADE,
  txn_date date NOT NULL,
  type text NOT NULL,                              -- top_up | expense | adjustment
  amount numeric(16,2) NOT NULL,
  description text,
  payee text,
  category text,
  reference text,                                  -- voucher / reference no.
  project_id text REFERENCES project(id) ON DELETE SET NULL,
  file_key text, file_name text,                   -- receipt attachment
  approved_by text, approved_at timestamptz,
  recorded_by_id text, recorded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_petty_cash_txn_account ON petty_cash_txn(account_id);
ALTER TABLE petty_cash_txn ADD COLUMN IF NOT EXISTS budget_line_id text;
ALTER TABLE petty_cash_txn ADD COLUMN IF NOT EXISTS expenditure_id text;

-- ===================== Grant Agreements / Income Register =====================
-- A signed donor/funding agreement: total committed, with a tranche schedule
-- (expected instalments) and receipts of grant income recorded against it.
CREATE TABLE IF NOT EXISTS funding_agreement (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  donor text NOT NULL,
  title text NOT NULL,
  reference text,                              -- agreement / contract no.
  project_id text REFERENCES project(id) ON DELETE SET NULL,
  currency text NOT NULL DEFAULT 'USD',
  total_amount numeric(18,2) NOT NULL DEFAULT 0,
  signed_date date, start_date date, end_date date,
  status text NOT NULL DEFAULT 'active',        -- active | closed | draft
  focal_person text,
  file_key text, file_name text,                -- signed agreement document
  notes text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_funding_agreement_org ON funding_agreement(org_id);

CREATE TABLE IF NOT EXISTS funding_tranche (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  agreement_id text NOT NULL REFERENCES funding_agreement(id) ON DELETE CASCADE,
  label text NOT NULL,                          -- 'Tranche 1', 'Year 1' ...
  expected_date date,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  condition text,                               -- milestone / condition for release
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_funding_tranche_agreement ON funding_tranche(agreement_id);

CREATE TABLE IF NOT EXISTS funding_receipt (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  agreement_id text NOT NULL REFERENCES funding_agreement(id) ON DELETE CASCADE,
  tranche_id text REFERENCES funding_tranche(id) ON DELETE SET NULL,
  receipt_date date NOT NULL,
  amount numeric(18,2) NOT NULL,
  reference text,                               -- bank / transfer reference
  method text,                                  -- bank transfer | cheque | cash | mobile
  file_key text, file_name text,                -- remittance advice / receipt
  notes text,
  recorded_by_id text, recorded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_funding_receipt_agreement ON funding_receipt(agreement_id);

-- ===================== Reserves & Investments (Treasury) =====================
-- Designated reserve funds built up and drawn down via movements.
CREATE TABLE IF NOT EXISTS reserve_fund (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'general',         -- general | capital | contingency | restricted | endowment | other
  purpose text,
  currency text NOT NULL DEFAULT 'USD',
  target_amount numeric(18,2),                  -- optional funding target
  status text NOT NULL DEFAULT 'active',         -- active | closed
  opened_date date,
  notes text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reserve_fund_org ON reserve_fund(org_id);

-- allocation/adjustment increase the reserve; utilization decreases it.
CREATE TABLE IF NOT EXISTS reserve_movement (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  fund_id text NOT NULL REFERENCES reserve_fund(id) ON DELETE CASCADE,
  movement_date date NOT NULL,
  type text NOT NULL,                           -- allocation | utilization | adjustment
  amount numeric(18,2) NOT NULL,
  description text,
  reference text,
  project_id text REFERENCES project(id) ON DELETE SET NULL,
  recorded_by_id text, recorded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reserve_movement_fund ON reserve_movement(fund_id);

-- Investments / placements (fixed deposits, T-bills, bonds, etc.).
CREATE TABLE IF NOT EXISTS investment (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  institution text,                             -- bank / broker
  instrument_type text NOT NULL DEFAULT 'fixed_deposit',  -- fixed_deposit | treasury_bill | bond | money_market | shares | other
  currency text NOT NULL DEFAULT 'USD',
  principal numeric(18,2) NOT NULL DEFAULT 0,   -- original amount placed
  interest_rate numeric(7,3),                   -- annual % (informational)
  placement_date date, maturity_date date,
  expected_value numeric(18,2),                 -- expected value at maturity
  status text NOT NULL DEFAULT 'active',         -- active | matured | liquidated
  reference text,
  notes text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_investment_org ON investment(org_id);

-- placement adds principal; withdrawal/maturity reduce it; interest is income.
CREATE TABLE IF NOT EXISTS investment_movement (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  investment_id text NOT NULL REFERENCES investment(id) ON DELETE CASCADE,
  movement_date date NOT NULL,
  type text NOT NULL,                           -- placement | interest | withdrawal | maturity | adjustment
  amount numeric(18,2) NOT NULL,
  description text,
  reference text,
  recorded_by_id text, recorded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_investment_movement_inv ON investment_movement(investment_id);

-- ===================== Rolling Cash Forecast =====================
-- A forward cash-position projection: opening balance + monthly buckets of
-- expected inflows/outflows (manual lines plus optional auto-pulls from funding
-- tranches and investment maturities).
CREATE TABLE IF NOT EXISTS cash_forecast (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  opening_balance numeric(18,2) NOT NULL DEFAULT 0,
  start_date date NOT NULL,
  months integer NOT NULL DEFAULT 6,             -- horizon length
  include_funding boolean NOT NULL DEFAULT true,  -- pull expected funding tranches
  include_investments boolean NOT NULL DEFAULT true, -- pull investment maturities
  status text NOT NULL DEFAULT 'active',           -- active | archived
  notes text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cash_forecast_org ON cash_forecast(org_id);

CREATE TABLE IF NOT EXISTS cash_forecast_line (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  forecast_id text NOT NULL REFERENCES cash_forecast(id) ON DELETE CASCADE,
  line_date date NOT NULL,
  direction text NOT NULL,                       -- inflow | outflow
  category text,
  description text,
  amount numeric(18,2) NOT NULL,
  recurring text NOT NULL DEFAULT 'none',         -- none | monthly
  recur_until date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cash_forecast_line_fc ON cash_forecast_line(forecast_id);

-- ===================== Whistleblower / Confidential Reporting =====================
-- A confidential (optionally anonymous) report. The tracking_code is the
-- reporter's access token for following up without an account.
CREATE TABLE IF NOT EXISTS whistleblower_report (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  tracking_code text UNIQUE NOT NULL,
  category text,
  title text NOT NULL,
  description text,
  is_anonymous boolean NOT NULL DEFAULT true,
  reporter_name text, reporter_contact text,        -- only if the reporter chose to identify
  incident_date date, location text, persons_involved text,
  severity text NOT NULL DEFAULT 'medium',           -- low | medium | high | critical
  status text NOT NULL DEFAULT 'submitted',          -- submitted | under_review | investigating | resolved | dismissed | closed
  handler text,                                      -- assigned reviewer / ethics officer
  retaliation_concern boolean NOT NULL DEFAULT false,
  outcome text, outcome_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_whistleblower_report_org ON whistleblower_report(org_id);
CREATE INDEX IF NOT EXISTS idx_whistleblower_report_code ON whistleblower_report(tracking_code);

-- Two-way thread. internal notes are visible to reviewers only (never the reporter).
CREATE TABLE IF NOT EXISTS whistleblower_message (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  report_id text NOT NULL REFERENCES whistleblower_report(id) ON DELETE CASCADE,
  sender text NOT NULL,                              -- reporter | reviewer
  author_name text,                                  -- reviewer name; null for anonymous reporter
  body text,
  internal boolean NOT NULL DEFAULT false,
  file_key text, file_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whistleblower_message_report ON whistleblower_message(report_id);

-- ===================== External Audit / Compliance Reviews =====================
-- An audit or compliance-review engagement, its findings, and the remediation
-- trail (management action plan) for each finding.
CREATE TABLE IF NOT EXISTS audit_engagement (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  title text NOT NULL,
  type text NOT NULL DEFAULT 'external_audit',   -- external_audit | internal_audit | donor_audit | compliance_review | statutory_audit
  auditor text,                                  -- audit firm / reviewer
  fiscal_year text,
  scope text,
  period_start date, period_end date,
  start_date date, end_date date, report_date date,
  status text NOT NULL DEFAULT 'planned',         -- planned | fieldwork | draft_report | finalized | closed
  opinion text,                                   -- overall opinion / rating
  lead_contact text,
  file_key text, file_name text,                  -- audit report document
  notes text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_engagement_org ON audit_engagement(org_id);

CREATE TABLE IF NOT EXISTS audit_finding (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  engagement_id text NOT NULL REFERENCES audit_engagement(id) ON DELETE CASCADE,
  ref text,                                       -- F-01, F-02 ...
  area text,                                      -- financial controls | procurement | HR | governance ...
  title text NOT NULL,
  observation text,
  risk text NOT NULL DEFAULT 'medium',            -- high | medium | low
  recommendation text,
  mgmt_response text,                             -- management response
  agreed_action text,
  responsible text,
  target_date date,
  status text NOT NULL DEFAULT 'open',            -- open | in_progress | implemented | accepted_risk | closed
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_finding_engagement ON audit_finding(engagement_id);

CREATE TABLE IF NOT EXISTS audit_finding_update (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  finding_id text NOT NULL REFERENCES audit_finding(id) ON DELETE CASCADE,
  update_date date NOT NULL,
  note text,
  status_at text,                                 -- status recorded at this update
  author text,
  file_key text, file_name text,                  -- evidence of remediation
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_finding_update_finding ON audit_finding_update(finding_id);

-- ===================== Staff Satisfaction / Engagement Surveys =====================
-- An (optionally anonymous) survey distributed to staff via a public token link.
CREATE TABLE IF NOT EXISTS survey (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  token text UNIQUE NOT NULL,
  title text NOT NULL,
  description text,
  intro text,                            -- shown to respondents at the top
  thank_you text,                        -- shown after submission
  anonymous boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'draft',  -- draft | open | closed
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  opened_at timestamptz, closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_survey_org ON survey(org_id);
CREATE INDEX IF NOT EXISTS idx_survey_token ON survey(token);

CREATE TABLE IF NOT EXISTS survey_question (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  survey_id text NOT NULL REFERENCES survey(id) ON DELETE CASCADE,
  prompt text NOT NULL,
  type text NOT NULL DEFAULT 'scale',    -- scale | rating | single_choice | yes_no | text
  options text,                          -- newline-separated options for single_choice
  required boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_survey_question_survey ON survey_question(survey_id);

-- One submission. respondent fields are only captured for non-anonymous surveys.
CREATE TABLE IF NOT EXISTS survey_response (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  survey_id text NOT NULL REFERENCES survey(id) ON DELETE CASCADE,
  respondent_name text, department text,
  submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_survey_response_survey ON survey_response(survey_id);

CREATE TABLE IF NOT EXISTS survey_answer (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  response_id text NOT NULL REFERENCES survey_response(id) ON DELETE CASCADE,
  question_id text NOT NULL REFERENCES survey_question(id) ON DELETE CASCADE,
  value_num double precision,            -- scale/rating/yes_no (1/0)
  value_text text                        -- text answers and chosen option
);
CREATE INDEX IF NOT EXISTS idx_survey_answer_response ON survey_answer(response_id);
CREATE INDEX IF NOT EXISTS idx_survey_answer_question ON survey_answer(question_id);

-- Targeted distribution: a recipient gets a unique invite token. Completion is
-- tracked (responded) but the response itself is NEVER linked to the recipient,
-- so answers stay anonymous while response rates are visible.
CREATE TABLE IF NOT EXISTS survey_recipient (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  survey_id text NOT NULL REFERENCES survey(id) ON DELETE CASCADE,
  employee_id text REFERENCES employee(id) ON DELETE SET NULL,
  name text,
  email text,
  department text,
  project_id text REFERENCES project(id) ON DELETE SET NULL,
  source text,                              -- department | project | individual
  token text UNIQUE NOT NULL,
  sent boolean NOT NULL DEFAULT false,
  sent_at timestamptz,
  responded boolean NOT NULL DEFAULT false,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_survey_recipient_survey ON survey_recipient(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_recipient_token ON survey_recipient(token);
-- link employee -> department (replaces the free-text department column for scoping)
ALTER TABLE employee ADD COLUMN IF NOT EXISTS department_id text;

-- Employee personal documents (CV, certificates) — visible only to the
-- employee themselves and HR admins, NEVER mixed with project documents.
CREATE TABLE IF NOT EXISTS employee_document (
  id text PRIMARY KEY,
  employee_id text NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  name text NOT NULL,
  doc_type text NOT NULL DEFAULT 'other', -- cv | certificate | id | contract | other
  storage_key text,
  mime_type text,
  size_bytes integer,
  uploaded_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Extended CV/profile fields employees populate themselves.
ALTER TABLE employee ADD COLUMN IF NOT EXISTS cv_summary text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS qualifications text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS skills text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS national_id text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS emergency_contact text;

-- ===========================================================================
-- RICHER EMPLOYEE RECORDS + TERMINATION WORKFLOW + COLLABORATIONS + DUAL CCY
-- ===========================================================================

-- Demographic / statutory fields on the employee record.
ALTER TABLE employee ADD COLUMN IF NOT EXISTS prefix text;              -- Dr, Prof, Assoc. Prof, Ms, Mr, Sr...
ALTER TABLE employee ADD COLUMN IF NOT EXISTS gender text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS marital_status text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS nationality text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS nssf_number text;         -- social security number
ALTER TABLE employee ADD COLUMN IF NOT EXISTS tin_number text;          -- tax identification number
ALTER TABLE employee ADD COLUMN IF NOT EXISTS next_of_kin text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS next_of_kin_relationship text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS next_of_kin_phone text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS next_of_kin_address text;

-- Flexible statutory/policy numbers beyond the common ones (e.g. professional
-- body registration, insurance policy numbers). Free-form label + value.
CREATE TABLE IF NOT EXISTS employee_policy_number (
  id text PRIMARY KEY,
  employee_id text NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  label text NOT NULL,                 -- 'NSSF', 'Medical insurance', 'Professional council'
  value text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Education / qualifications history (degrees, certificates, fellowships, trainings).
CREATE TABLE IF NOT EXISTS employee_education (
  id text PRIMARY KEY,
  employee_id text NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'degree', -- degree | certificate | fellowship | training | other
  qualification text NOT NULL,         -- 'PhD Epidemiology', 'GCP certificate'
  institution text,
  year_obtained text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Termination / access-revocation requests: HR submits, PI approves, then executes.
CREATE TABLE IF NOT EXISTS hr_action_request (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  employee_id text NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  action_type text NOT NULL,           -- terminate | revoke_access
  reason text,
  effective_date date,
  status text NOT NULL DEFAULT 'pending', -- pending | approved | rejected | executed
  requested_by text, requested_by_name text,
  decided_by text, decided_by_name text, decided_at timestamptz, decision_note text,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- COLLABORATIONS MODULE (external partners — a separate people directory)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS collaborator (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  prefix text,
  name text NOT NULL,
  organisation text,                   -- their home institution
  collaborator_type text NOT NULL DEFAULT 'institution', -- institution | individual | funder | partner_ngo | government
  email text, phone text, country text, address text,
  expertise text,
  website text,
  status text NOT NULL DEFAULT 'active', -- active | inactive
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collaborator_org ON collaborator(org_id);

-- A collaborator's role on a specific project (many-to-many with a role label).
CREATE TABLE IF NOT EXISTS project_collaborator (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  collaborator_id text NOT NULL REFERENCES collaborator(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'collaborator', -- co_investigator | partner | funder | advisor | sub_grantee | collaborator
  responsibilities text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, collaborator_id)
);

-- Dual-currency display on the dashboard: a secondary display currency per org.
ALTER TABLE organization ADD COLUMN IF NOT EXISTS display_currency text;

-- ===========================================================================
-- ORGANIZATION PROFILE (managed by org admins; logo + address = letterhead)
-- ===========================================================================
ALTER TABLE organization ADD COLUMN IF NOT EXISTS logo_data_url text;   -- uploaded logo (data URL, used on printouts)
ALTER TABLE organization ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS slogan text;          -- motto / tagline
ALTER TABLE organization ADD COLUMN IF NOT EXISTS mission text;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS vision text;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS values_text text;     -- 'values' is reserved-ish; use values_text
ALTER TABLE organization ADD COLUMN IF NOT EXISTS objectives text;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS registration_no text;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS social_twitter text;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS social_linkedin text;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS social_facebook text;

-- ===========================================================================
-- COMPENSATION ENGINE (grant-model payroll)
-- Sits alongside the component-based monthly payroll. The institution enters
-- the GROSS actually paid (or base + % effort for grant charging) plus a fringe
-- pool; a configurable engine derives NSSF (employee + employer), PAYE / WHT,
-- net pay, and fringe used vs unused. Employer NSSF is a SAVING funded from the
-- fringe pool — it never inflates gross or net pay. Consultants are withheld
-- only (no NSSF/PAYE). No tax rate is hard-coded: every value is editable.
-- ===========================================================================

-- One configurable row per organisation. Percentages are stored as whole
-- numbers (15 = 15%). Defaults reflect the institution's stated practice.
CREATE TABLE IF NOT EXISTS comp_config (
  org_id text PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  nssf_employer_pct numeric(7,4) NOT NULL DEFAULT 10,   -- employer NSSF, % of gross (statutory UG = 10; a saving from fringe)
  nssf_employee_pct numeric(7,4) NOT NULL DEFAULT 5,    -- employee NSSF, % of gross (a saving)
  consultant_wht_pct numeric(7,4) NOT NULL DEFAULT 6,   -- withholding tax on consultant funds, %
  paye_method text NOT NULL DEFAULT 'uganda',           -- uganda | flat | none
  paye_flat_pct numeric(7,4) NOT NULL DEFAULT 0,        -- used when paye_method='flat'
  paye_bands text,                                       -- optional JSON override of the marginal bands
  nssf_employer_from_fringe boolean NOT NULL DEFAULT true,  -- employer NSSF drawn from the fringe pool
  nssf_employee_from_fringe boolean NOT NULL DEFAULT false, -- employee NSSF from fringe instead of gross
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Per-employee compensation under the grant model (one row per employee).
CREATE TABLE IF NOT EXISTS employee_compensation (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  employee_id text NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  project_id text REFERENCES project(id) ON DELETE SET NULL,  -- optional: lets comp roll up per project
  employment_type text NOT NULL DEFAULT 'staff',   -- staff | consultant
  currency text NOT NULL DEFAULT 'USD',
  gross_salary numeric(18,2),                       -- staff: the contracted gross actually paid
  base_salary numeric(18,2),                        -- staff: base for grant charging (charged = base × effort)
  effort_pct numeric(7,4) NOT NULL DEFAULT 100,     -- % effort (0..100)
  cal_months numeric(5,2),                          -- informational (calendar months)
  fringe_amount numeric(18,2),                      -- explicit fringe pool amount, OR…
  fringe_rate_pct numeric(7,4),                     -- …a rate applied to the fringe basis (e.g. 30)
  fringe_basis text NOT NULL DEFAULT 'base',        -- base | charged
  requested_funds numeric(18,2),                    -- consultant: total requested funds (WHT applies)
  benefits text NOT NULL DEFAULT '[]',              -- JSON [{label, amount}] other fringe (fuel, gym…)
  note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id)
);
CREATE INDEX IF NOT EXISTS idx_empcomp_org ON employee_compensation(org_id);
CREATE INDEX IF NOT EXISTS idx_empcomp_project ON employee_compensation(project_id);

-- ===========================================================================
-- COLLABORATOR VIEW-ONLY LOGINS
-- An external collaborator may be granted a restricted login that can only see
-- the projects they are linked to, and only the Overview / SOW / Work plan /
-- Gantt / Objectives tabs — never budget, spending, requisitions, etc.
-- ===========================================================================
ALTER TABLE collaborator ADD COLUMN IF NOT EXISTS user_id text REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS is_collaborator boolean NOT NULL DEFAULT false;

-- ===========================================================================
-- PURCHASE REQUEST → PROJECT BUDGET LINKAGE
-- A purchase request can be charged to a specific project budget line. When the
-- request is approved, its estimated total is committed against that line so it
-- shows up in the project's budget as reserved funds (reducing the remaining
-- balance). source/source_id on commitment give traceability and prevent a
-- request from being committed twice.
-- ===========================================================================
ALTER TABLE purchase_request ADD COLUMN IF NOT EXISTS budget_line_id text REFERENCES budget_line(id) ON DELETE SET NULL;
ALTER TABLE commitment ADD COLUMN IF NOT EXISTS source text;      -- e.g. 'purchase_request'
ALTER TABLE commitment ADD COLUMN IF NOT EXISTS source_id text;   -- originating record id
CREATE INDEX IF NOT EXISTS idx_commitment_source ON commitment(source, source_id);

-- Per-employee PAYE override (flat %, optional) and additional deduction/saving
-- schemes (SACCO, local service tax, insurance…) stored as JSON [{label,value,kind}].
ALTER TABLE employee_compensation ADD COLUMN IF NOT EXISTS paye_override_pct numeric(7,4);
ALTER TABLE employee_compensation ADD COLUMN IF NOT EXISTS deductions text NOT NULL DEFAULT '[]';

-- ===========================================================================
-- STAFF ↔ PROJECT ASSIGNMENTS
-- Which employees work on which projects, with a role and responsibilities.
-- This is the HR/PI view of project staffing (who does what), distinct from the
-- login-based project_member table that governs app access. Editable by HR/org
-- admins (from the employee profile) and by PIs (from the project Team page).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS employee_project (
  id text PRIMARY KEY,
  employee_id text NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  role text,
  responsibilities text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_empproj_employee ON employee_project(employee_id);
CREATE INDEX IF NOT EXISTS idx_empproj_project ON employee_project(project_id);

-- ===========================================================================
-- FINANCIAL YEARS
-- Org-defined accounting periods (begin/end). Finance summaries can be scoped
-- to a financial year. One year may be flagged as the current/active period.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS financial_year (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,                 -- e.g. "FY2025/26"
  start_date date NOT NULL,
  end_date date NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_fy_org ON financial_year(org_id);

-- ===========================================================================
-- SUB-AWARDS  (sub-grants / pass-through awards)
-- When the organisation passes a portion of a project's funding to an external
-- organisation (a sub-grantee) to run some activities, that relationship is a
-- sub-award. Tracked here with its source project, amount, period and status,
-- plus disbursement tranches. Surfaced both as its own module and in Finance.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS subaward (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text REFERENCES project(id) ON DELETE SET NULL,   -- funded from this project
  collaborator_id text REFERENCES collaborator(id) ON DELETE SET NULL, -- if the grantee is a registered partner
  grantee_name text NOT NULL,         -- the sub-grantee organisation
  title text NOT NULL,                -- scope / purpose of the sub-award
  reference text,                     -- agreement / contract number
  description text,                   -- activities the grantee will run
  deliverables text,                  -- expected outputs / milestones
  amount numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  start_date date,
  end_date date,
  status text NOT NULL DEFAULT 'draft', -- draft | active | suspended | completed | closed
  contact_name text,
  contact_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subaward_org ON subaward(org_id);
CREATE INDEX IF NOT EXISTS idx_subaward_project ON subaward(project_id);

-- Disbursement tranches paid to the sub-grantee against a sub-award.
CREATE TABLE IF NOT EXISTS subaward_payment (
  id text PRIMARY KEY,
  subaward_id text NOT NULL REFERENCES subaward(id) ON DELETE CASCADE,
  paid_on date NOT NULL,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  reference text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subpay_award ON subaward_payment(subaward_id);

-- Employees may record an alternative (personal) email; the primary email is
-- managed by HR and stays read-only to the employee.
ALTER TABLE employee ADD COLUMN IF NOT EXISTS alternative_email text;

-- ===========================================================================
-- ADVANCE ACCOUNTABILITY CONTROLS (VITAL HMB Finance Policy §13.2, §15)
-- Track how much of a disbursed advance has been accounted for, when it was
-- disbursed, and the 60-day accountability deadline. Enables the "75% rule"
-- (no new advance while >25% of the previous one is unaccounted) and overdue /
-- personal-liability escalation.
-- ===========================================================================
ALTER TABLE requisition ADD COLUMN IF NOT EXISTS accounted_amount double precision NOT NULL DEFAULT 0;
ALTER TABLE requisition ADD COLUMN IF NOT EXISTS disbursed_on timestamptz;
ALTER TABLE requisition ADD COLUMN IF NOT EXISTS accountability_due date;

-- ===========================================================================
-- STATUTORY DEDUCTIONS & REMITTANCE (VITAL HMB Finance Policy §17)
-- Employer NSSF default aligned to the statutory 10%, plus optional Local
-- Service Tax, and a register that tracks PAYE/NSSF/LST/WHT remittances with
-- their due dates (15th of the following month) and proof of payment.
-- ===========================================================================
ALTER TABLE comp_config ALTER COLUMN nssf_employer_pct SET DEFAULT 10;
ALTER TABLE comp_config ADD COLUMN IF NOT EXISTS lst_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE comp_config ADD COLUMN IF NOT EXISTS lst_bands text;            -- optional JSON LST schedule
ALTER TABLE comp_config ADD COLUMN IF NOT EXISTS lst_divisor integer NOT NULL DEFAULT 12;

CREATE TABLE IF NOT EXISTS statutory_remittance (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  period text NOT NULL,                -- the pay period, e.g. '2026-05'
  tax_type text NOT NULL,              -- paye | nssf | lst | wht
  amount numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  due_date date NOT NULL,              -- statutory deadline (15th of following month)
  paid_on date,                        -- when remitted (null = outstanding)
  reference text,                      -- URA/NSSF receipt or transaction reference
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_remit_org ON statutory_remittance(org_id);

-- ===========================================================================
-- PROCUREMENT COMPETITION (VITAL HMB Procurement Policy §6, §7)
-- Quotations captured against a purchase request, a configurable threshold
-- matrix that sets how many quotes each value tier needs, and a single-source
-- justification when fewer can be obtained. Plus the three-way-match gate
-- (enforced in code: no vendor bill without a Goods Received Note).
-- ===========================================================================
ALTER TABLE purchase_request ADD COLUMN IF NOT EXISTS single_source_justification text;

CREATE TABLE IF NOT EXISTS pr_quotation (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES purchase_request(id) ON DELETE CASCADE,
  vendor_id text REFERENCES vendor(id),
  vendor_name text NOT NULL,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  lead_time_days integer,
  notes text,
  selected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quotation_request ON pr_quotation(request_id);

-- Org-level procurement thresholds (in the config currency). Defaults mirror the
-- policy: ≤1,000,000 → 1 quote; ≤5,000,000 → 3 quotes; above → formal bids (3).
CREATE TABLE IF NOT EXISTS procurement_config (
  org_id text PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'USD',
  direct_max numeric(18,2) NOT NULL DEFAULT 1000000,
  micro_max numeric(18,2) NOT NULL DEFAULT 5000000,
  quotes_direct integer NOT NULL DEFAULT 1,
  quotes_micro integer NOT NULL DEFAULT 3,
  quotes_formal integer NOT NULL DEFAULT 3,
  enforce boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- ASSET CONDITION, VERIFICATION & DISPOSAL (Finance Policy §18)
-- ===========================================================================
ALTER TABLE fixed_asset ADD COLUMN IF NOT EXISTS condition text NOT NULL DEFAULT 'good'; -- good | fair | poor
ALTER TABLE fixed_asset ADD COLUMN IF NOT EXISTS last_verified_on date;
ALTER TABLE fixed_asset ADD COLUMN IF NOT EXISTS disposal_method text;        -- sold | donated | scrapped | transferred
ALTER TABLE fixed_asset ADD COLUMN IF NOT EXISTS disposal_proceeds numeric(18,2);
ALTER TABLE fixed_asset ADD COLUMN IF NOT EXISTS disposal_approved_by text;   -- PI / authority who approved
ALTER TABLE fixed_asset ADD COLUMN IF NOT EXISTS disposal_note text;
ALTER TABLE fixed_asset ADD COLUMN IF NOT EXISTS disposed_on date;

CREATE TABLE IF NOT EXISTS asset_verification (
  id text PRIMARY KEY,
  asset_id text NOT NULL REFERENCES fixed_asset(id) ON DELETE CASCADE,
  verified_on date NOT NULL,
  verified_by text, verified_by_name text,
  condition_found text,        -- good | fair | poor | missing
  location_found text,
  discrepancy_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assetverif_asset ON asset_verification(asset_id);

-- ===========================================================================
-- PER DIEM & TRAVEL (Finance Policy §14.2): rate schedule + claims that require
-- an activity report before they can be approved or paid.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS perdiem_rate (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  category text NOT NULL,         -- e.g. 'In-country', 'Senior staff', 'Driver'
  daily_rate numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS perdiem_claim (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text REFERENCES project(id) ON DELETE SET NULL,
  employee_id text REFERENCES employee(id) ON DELETE SET NULL,
  traveller_name text NOT NULL,
  purpose text,
  destination text,
  start_date date, end_date date,
  days numeric(8,2) NOT NULL DEFAULT 0,
  daily_rate numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  total numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',  -- draft | approved | paid | rejected
  activity_report text,
  approved_by text, approved_by_name text, approved_at timestamptz,
  paid_on date, payment_ref text,
  created_by text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_perdiem_org ON perdiem_claim(org_id);
CREATE TABLE IF NOT EXISTS perdiem_evidence (
  id text PRIMARY KEY,
  claim_id text NOT NULL REFERENCES perdiem_claim(id) ON DELETE CASCADE,
  name text NOT NULL, storage_key text, mime_type text, size_bytes integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- PROCUREMENT PLAN (Procurement Policy §5): consolidated planned purchases by
-- period, reviewed against budget before procurement proceeds.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS procurement_plan_item (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text REFERENCES project(id) ON DELETE SET NULL,
  period text NOT NULL,          -- e.g. '2025-Q3' or 'FY2025/26'
  description text NOT NULL,
  category text,
  quantity numeric(18,2) NOT NULL DEFAULT 1,
  est_unit_cost numeric(18,2) NOT NULL DEFAULT 0,
  est_total numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  needed_by date,
  department text,
  status text NOT NULL DEFAULT 'planned',  -- planned | requested | procured | cancelled
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_procplan_org ON procurement_plan_item(org_id);

-- ===========================================================================
-- ETHICS REGISTERS (Procurement Policy §7, §11): conflict-of-interest
-- declarations and a gifts/inducements log.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS coi_declaration (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  person_name text NOT NULL,
  role text,
  related_to text,        -- supplier / procurement / vendor concerned
  nature text NOT NULL,   -- description of the conflict
  action text,            -- e.g. 'withdrew from evaluation'
  declared_on date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coi_org ON coi_declaration(org_id);
CREATE TABLE IF NOT EXISTS gift_log (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  person_name text NOT NULL,
  supplier_name text,
  description text NOT NULL,
  est_value numeric(18,2),
  currency text NOT NULL DEFAULT 'USD',
  received_on date NOT NULL,
  action_taken text,      -- e.g. 'declined', 'surrendered to project'
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gift_org ON gift_log(org_id);

-- ===========================================================================
-- SUBSCRIPTIONS, RECEIPTS, RENEWAL REMINDERS & PLATFORM ANNOUNCEMENTS
-- Paid organisations renew on fixed terms (1/3/5 years). We track the expiry,
-- record payments + emailed receipts, throttle renewal reminders, and log
-- operator broadcasts.
-- ===========================================================================
ALTER TABLE organization ADD COLUMN IF NOT EXISTS subscription_ends_at timestamptz;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS subscription_term_months integer;

CREATE TABLE IF NOT EXISTS subscription_payment (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  receipt_no text,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  term_months integer NOT NULL DEFAULT 12,
  period_start date,
  period_end date,
  reference text,
  note text,
  paid_on date NOT NULL,
  receipt_sent_at timestamptz,
  created_by text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subpay_org ON subscription_payment(org_id);

-- One row per (org, threshold, expiry) so each reminder fires only once per cycle.
CREATE TABLE IF NOT EXISTS subscription_reminder (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  reminder_kind text NOT NULL,   -- '30d' | '14d' | '7d' | 'expired'
  expiry date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, reminder_kind, expiry)
);

CREATE TABLE IF NOT EXISTS platform_announcement (
  id text PRIMARY KEY,
  subject text NOT NULL,
  body text NOT NULL,
  audience text NOT NULL,        -- 'all' | 'active' | 'trial'
  recipients integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  created_by text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- SUBSCRIPTION RENEWAL REQUESTS (org → invoice → proof of payment → renew)
-- An organisation admin/finance requests a renewal term; the operator issues an
-- invoice (rates, VAT, bank & mobile-money details); the organisation pays and
-- uploads proof; the operator approves and the subscription is renewed.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS subscription_request (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'requested', -- requested | invoiced | payment_submitted | approved | rejected | cancelled
  term_months integer NOT NULL DEFAULT 12,
  requested_by text, requested_by_name text, requested_at timestamptz NOT NULL DEFAULT now(),
  note text,
  -- invoice (operator)
  invoice_no text,
  invoice_subtotal numeric(18,2),
  vat_rate numeric(7,4),
  vat_amount numeric(18,2),
  invoice_total numeric(18,2),
  currency text DEFAULT 'USD',
  bank_details text,
  momo_details text,
  invoice_note text,
  invoiced_at timestamptz, invoiced_by text, invoiced_by_name text,
  -- proof of payment (organisation)
  payment_storage_key text, payment_file_name text, payment_mime text, payment_size integer,
  payment_ref text, payment_note text, payment_submitted_at timestamptz,
  -- completion (operator)
  completed_at timestamptz, completed_by text, completed_by_name text,
  reject_reason text,
  payment_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subreq_org ON subscription_request(org_id);
CREATE INDEX IF NOT EXISTS idx_subreq_status ON subscription_request(status);

-- Platform billing defaults used to pre-fill invoices (one global row).
CREATE TABLE IF NOT EXISTS platform_settings (
  id text PRIMARY KEY,
  currency text NOT NULL DEFAULT 'USD',
  vat_rate numeric(7,4) NOT NULL DEFAULT 0,
  rate_1yr numeric(18,2) NOT NULL DEFAULT 0,
  rate_3yr numeric(18,2) NOT NULL DEFAULT 0,
  rate_5yr numeric(18,2) NOT NULL DEFAULT 0,
  bank_details text,
  momo_details text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- TAX IDS + PLATFORM ISSUER IDENTITY (for invoices & receipts)
-- Organisations get a TIN (bill-to party). The platform/operator gets a full
-- issuer profile — name, TIN, address, contacts, logo — shown as the "from"
-- letterhead on invoices and receipts.
-- ===========================================================================
ALTER TABLE organization ADD COLUMN IF NOT EXISTS tin text;  -- tax identification number

ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS issuer_name text;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS issuer_tin text;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS issuer_address text;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS issuer_email text;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS issuer_phone text;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS issuer_website text;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS issuer_logo_data_url text;

-- Journal entries carry a source-document reference (voucher/invoice/receipt no.)
-- in addition to their serial entry_no, per accounting referencing practice.
ALTER TABLE journal_entry ADD COLUMN IF NOT EXISTS reference text;

-- Organisation receiving-bank details, shown on invoices ("pay to").
ALTER TABLE organization ADD COLUMN IF NOT EXISTS bank_details text;

-- Timesheet approval parity with leave: capture a decision note and timestamp.
ALTER TABLE timesheet ADD COLUMN IF NOT EXISTS decision_note text;
ALTER TABLE timesheet ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- Letter-style grantor invoicing: customer attention contact + per-invoice award details & signatory.
ALTER TABLE finance_customer ADD COLUMN IF NOT EXISTS contact_name text;   -- "Attention:" person
ALTER TABLE finance_customer ADD COLUMN IF NOT EXISTS contact_title text;
ALTER TABLE finance_customer ADD COLUMN IF NOT EXISTS fax text;
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS award_number text;
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS awardee text;
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS signatory_name text;
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS signatory_title text;

-- Bank reconciliation: mark individual ledger cash movements as cleared on the
-- bank statement, and keep a per-account, per-month reconciliation record.
ALTER TABLE journal_line ADD COLUMN IF NOT EXISTS cleared boolean NOT NULL DEFAULT false;
ALTER TABLE journal_line ADD COLUMN IF NOT EXISTS cleared_at timestamptz;

CREATE TABLE IF NOT EXISTS bank_reconciliation (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES ledger_account(id),
  period text NOT NULL,                      -- 'YYYY-MM'
  statement_closing numeric(18,2),           -- bank statement closing balance for the month
  note text,
  status text NOT NULL DEFAULT 'open',       -- open | finalized
  finalized_by text, finalized_by_name text, finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, account_id, period)
);

-- Standalone bank-payment vouchers (direct payments not tied to a requisition),
-- for bank reconciliation. Loosen the requisition/project requirement and add scoping.
ALTER TABLE payment_voucher ALTER COLUMN requisition_id DROP NOT NULL;
ALTER TABLE payment_voucher ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS voucher_date date;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS journal_entry_id text;

-- Payment vouchers as first-class documents: recordable standalone (not only from a
-- requisition), with an explicit date and the cash/expense accounts for ledger posting,
-- so they flow into the monthly bank reconciliation.
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS voucher_date date;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS account_id text;          -- cash/bank account credited
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS expense_account_id text;  -- account debited
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS journal_entry_id text;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS status text DEFAULT 'prepared';
ALTER TABLE payment_voucher ALTER COLUMN requisition_id DROP NOT NULL;
ALTER TABLE payment_voucher ALTER COLUMN project_id DROP NOT NULL;
-- Backfill org_id + voucher_date for vouchers created before these columns existed.
UPDATE payment_voucher SET org_id = (SELECT p.org_id FROM project p WHERE p.id = payment_voucher.project_id) WHERE org_id IS NULL AND project_id IS NOT NULL;
UPDATE payment_voucher SET voucher_date = created_at::date WHERE voucher_date IS NULL;

-- Draft/void invoices can be archived (hidden from the working list) or deleted.
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;

-- Currency chosen at import time for a budget file (empty/null = auto-detect from the file).
ALTER TABLE extraction_job ADD COLUMN IF NOT EXISTS currency text;

-- ============================================================================
-- PAYMENT SLIPS — bulk or individual payments (airtime, data, transcription,
-- transport, etc.) on letterhead, approved & signed by Finance and the PI, with
-- each payee able to e-sign against their name via an emailed link (no login).
-- ============================================================================
CREATE TABLE IF NOT EXISTS payment_slip (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text REFERENCES project(id) ON DELETE SET NULL,
  number text NOT NULL,                 -- 'PS-0001' per org
  title text NOT NULL,
  category text,                        -- Airtime / Data / Transcription / Transport / Other
  slip_date date NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'draft', -- draft → approved → disbursed → closed
  note text,
  prepared_by text REFERENCES app_user(id) ON DELETE SET NULL,
  prepared_by_name text,
  finance_signed_by text REFERENCES app_user(id) ON DELETE SET NULL,
  finance_signed_name text, finance_signature text, finance_signed_at timestamptz,
  pi_signed_by text REFERENCES app_user(id) ON DELETE SET NULL,
  pi_signed_name text, pi_signature text, pi_signed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_slip_payee (
  id text PRIMARY KEY,
  slip_id text NOT NULL REFERENCES payment_slip(id) ON DELETE CASCADE,
  idx int NOT NULL DEFAULT 0,            -- the "No." column
  name text NOT NULL,
  phone text,
  email text,
  designation text,
  payment_for text,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  sign_token text UNIQUE,               -- unguessable token for the public signing link
  signed boolean NOT NULL DEFAULT false,
  signature text,                       -- data URL (drawn) or typed name
  signed_name text,
  signed_at timestamptz,
  link_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_slip_org ON payment_slip(org_id);
CREATE INDEX IF NOT EXISTS idx_payment_slip_payee_slip ON payment_slip_payee(slip_id);
CREATE INDEX IF NOT EXISTS idx_payment_slip_payee_token ON payment_slip_payee(sign_token);

-- Configurable second signatory (not locked to the PI): Finance designates who must
-- authorise (manager, PI, co-investigator, anyone). Whoever signs that slot is stored
-- in the pi_signed_* columns; approver_title records what role they signed under.
ALTER TABLE payment_slip ADD COLUMN IF NOT EXISTS approver_id text REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE payment_slip ADD COLUMN IF NOT EXISTS approver_name text;
ALTER TABLE payment_slip ADD COLUMN IF NOT EXISTS approver_title text;
-- Link a payment slip / voucher to a project budget line so disbursement records an
-- expenditure against the line (which reduces its balance) and posts to the ledger.
ALTER TABLE payment_slip ADD COLUMN IF NOT EXISTS budget_line_id text REFERENCES budget_line(id) ON DELETE SET NULL;
ALTER TABLE payment_slip ADD COLUMN IF NOT EXISTS expenditure_id text;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS budget_line_id text REFERENCES budget_line(id) ON DELETE SET NULL;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS expenditure_id text;
-- Voucher approval workflow: a chosen employee (not necessarily an admin) approves
-- or declines; their name/signature link automatically and the budget deducts on approval.
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS approver_id text REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS approver_name text;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS approver_signature text;
ALTER TABLE payment_voucher ADD COLUMN IF NOT EXISTS decline_reason text;

-- Procurement approval chain: a purchase request is signed off step-by-step
-- (finance review -> budget holder / PI -> authorising officer). Each signatory is
-- assigned, emailed, and signs with their stored signature before the request is approved.
CREATE TABLE IF NOT EXISTS purchase_approval (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES purchase_request(id) ON DELETE CASCADE,
  step integer NOT NULL,
  role text NOT NULL,
  approver_id text, approver_name text,
  decision text NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  comment text, signature_data text,
  notified_at timestamptz, decided_at timestamptz
);
-- A purchase order carries the project budget line it charges and is signed
-- (authorised) by an authorising officer before being issued to the vendor.
ALTER TABLE purchase_order ADD COLUMN IF NOT EXISTS budget_line_id text REFERENCES budget_line(id) ON DELETE SET NULL;
ALTER TABLE purchase_order ADD COLUMN IF NOT EXISTS authorised_by text;
ALTER TABLE purchase_order ADD COLUMN IF NOT EXISTS authorised_by_name text;
ALTER TABLE purchase_order ADD COLUMN IF NOT EXISTS authorised_signature text;
ALTER TABLE purchase_order ADD COLUMN IF NOT EXISTS authorised_at timestamptz;

-- ===================== Laboratory (LIMS) =====================
-- Participant master index. Names are PII and masked from unauthorised roles.
CREATE TABLE IF NOT EXISTS lab_participant (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  study_id text NOT NULL,
  name text,
  date_of_birth date,
  sex text,
  enrollment_date date NOT NULL DEFAULT CURRENT_DATE,
  consent_status text NOT NULL DEFAULT 'valid', -- valid | expired | withdrawn
  withdrawal_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, study_id)
);
-- Sample type taxonomy (Category -> Type -> Sub-type) seeded per org.
CREATE TABLE IF NOT EXISTS lab_sample_type (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  category text NOT NULL,
  type text NOT NULL,
  sub_type text,
  default_temp text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Core sample registry. Each sample is scoped to a project (and org); aliquots point
-- to their parent via parent_sample_id.
CREATE TABLE IF NOT EXISTS lab_sample (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  sample_code text NOT NULL,             -- PROJ-YYYY-NNNN
  parent_sample_id text REFERENCES lab_sample(id) ON DELETE SET NULL,
  participant_id text REFERENCES lab_participant(id) ON DELETE SET NULL,
  sample_type_id text REFERENCES lab_sample_type(id) ON DELETE SET NULL,
  age_years int, age_months int,
  collection_date date NOT NULL,
  collection_time text,
  date_aliquoted date,
  number_of_aliquots int NOT NULL DEFAULT 0,
  aliquot_volume double precision,
  aliquot_unit text NOT NULL DEFAULT 'µL',
  quantity_remaining double precision,   -- current volume/count on hand
  storage_room text, storage_equipment text, storage_rack text,
  storage_shelf text, storage_box text, storage_position text,
  date_stored date, storage_temp text,
  stored_by_id text, stored_by_name text,
  condition_on_receipt text DEFAULT 'intact',
  abnormalities text, comments text,
  status text NOT NULL DEFAULT 'active', -- active | depleted | quarantined | in_transit | disposed
  disposal_date date, disposal_method text, disposal_reason text, disposal_witness text,
  disposed_by_id text, disposed_by_name text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, sample_code)
);
-- Retrieval / chain-of-custody log: each removal (and optional return) of a sample.
CREATE TABLE IF NOT EXISTS lab_retrieval (
  id text PRIMARY KEY,
  sample_id text NOT NULL REFERENCES lab_sample(id) ON DELETE CASCADE,
  date_retrieved timestamptz NOT NULL DEFAULT now(),
  quantity_removed double precision,
  quantity_remaining double precision,
  purpose text, destination text, new_shelf text,
  retrieved_by_id text, retrieved_by_name text,
  authorized_by_id text, authorized_by_name text,
  returned_date timestamptz, returned_to_shelf text, temp_exposure_minutes int,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- PII access audit: every reveal of a participant's name.
CREATE TABLE IF NOT EXISTS lab_pii_access (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id text, user_name text,
  participant_id text, sample_id text,
  accessed_at timestamptz NOT NULL DEFAULT now()
);

-- ===================== Studies (Clinical Trials & Cohorts) =====================
-- Management/oversight layer (CTMS-style) for trials and cohorts under a project.
-- This tracks the study, not individual participant data capture.
CREATE TABLE IF NOT EXISTS study (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  code text,
  title text NOT NULL,
  study_type text NOT NULL DEFAULT 'clinical_trial', -- clinical_trial | cohort | observational | other
  phase text,                              -- I | II | III | IV | NA
  design text,                             -- free text (e.g. randomized double-blind, prospective cohort)
  blinding text,                           -- open | single | double | NA
  randomized boolean NOT NULL DEFAULT false,
  allocation_ratio text,
  registry text, registration_number text, -- ClinicalTrials.gov / PACTR + id
  sponsor text, funder text,
  pi_id text REFERENCES app_user(id), pi_name text,
  target_enrollment int,
  status text NOT NULL DEFAULT 'planning', -- planning | startup | recruiting | active | follow_up | closed | suspended | terminated
  start_date date, end_date date,
  objectives text, summary text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Participating sites (multi-site studies).
CREATE TABLE IF NOT EXISTS study_site (
  id text PRIMARY KEY,
  study_id text NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  name text NOT NULL,
  location text,
  pi_name text,
  status text NOT NULL DEFAULT 'pending',  -- pending | active | closed | suspended
  activation_date date,
  target_enrollment int,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Regulatory & ethics approvals (REC / NDA / UNCST / sponsor) with expiry tracking.
CREATE TABLE IF NOT EXISTS study_approval (
  id text PRIMARY KEY,
  study_id text NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  authority text NOT NULL,                 -- REC | NDA | UNCST | sponsor | other
  authority_name text,
  reference_number text,
  approval_date date,
  expiry_date date,
  status text NOT NULL DEFAULT 'pending',  -- pending | approved | expired | suspended | withdrawn
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Protocol amendments and consent-form versions (one log, typed).
CREATE TABLE IF NOT EXISTS study_version (
  id text PRIMARY KEY,
  study_id text NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  doc_type text NOT NULL DEFAULT 'protocol', -- protocol | consent | sap | other
  version text NOT NULL,
  version_date date,
  language text,
  status text NOT NULL DEFAULT 'draft',    -- draft | submitted | approved | active | superseded
  summary text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Enrollment actuals (periodic deltas, summed) — aggregate counts, not individual records.
CREATE TABLE IF NOT EXISTS study_enrollment (
  id text PRIMARY KEY,
  study_id text NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  site_id text REFERENCES study_site(id) ON DELETE SET NULL,
  as_of_date date NOT NULL DEFAULT CURRENT_DATE,
  screened int NOT NULL DEFAULT 0,
  enrolled int NOT NULL DEFAULT 0,
  withdrawn int NOT NULL DEFAULT 0,
  completed int NOT NULL DEFAULT 0,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Study milestones (FPI, LPO, DSMB review, database lock, etc.).
CREATE TABLE IF NOT EXISTS study_milestone (
  id text PRIMARY KEY,
  study_id text NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  name text NOT NULL,
  planned_date date,
  actual_date date,
  status text NOT NULL DEFAULT 'pending',  -- pending | done | missed
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================== Per-tenant modules (multi-sector SaaS) =====================
ALTER TABLE organization ADD COLUMN IF NOT EXISTS org_type text;
-- Explicit per-org module on/off overrides (absence = org-type default).
CREATE TABLE IF NOT EXISTS org_module (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  module_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, module_key)
);

-- ===================== Procurement committees (formal/PPDA procurement) =====================
CREATE TABLE IF NOT EXISTS proc_committee (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'contracts',  -- contracts | evaluation | bid_opening | disposal | other
  name text NOT NULL,
  mandate text,
  status text NOT NULL DEFAULT 'active',    -- active | inactive
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS proc_committee_member (
  id text PRIMARY KEY,
  committee_id text NOT NULL REFERENCES proc_committee(id) ON DELETE CASCADE,
  user_id text REFERENCES app_user(id),
  member_name text NOT NULL,
  title text,
  committee_role text NOT NULL DEFAULT 'member', -- chairperson | secretary | member
  appointed_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================== Inventory & stores =====================
CREATE TABLE IF NOT EXISTS store (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  location text,
  status text NOT NULL DEFAULT 'active',   -- active | inactive
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS stock_item (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  code text,
  name text NOT NULL,
  category text,
  item_type text NOT NULL DEFAULT 'consumable', -- consumable | asset | other
  unit text NOT NULL DEFAULT 'unit',
  unit_cost numeric(18,2) NOT NULL DEFAULT 0,
  reorder_level numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',   -- active | inactive
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Signed-quantity ledger: receipts positive, issues/disposals negative, adjustments signed.
CREATE TABLE IF NOT EXISTS stock_movement (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES stock_item(id) ON DELETE CASCADE,
  store_id text REFERENCES store(id) ON DELETE SET NULL,
  kind text NOT NULL,                      -- receipt | issue | adjustment | disposal
  qty numeric(18,2) NOT NULL DEFAULT 0,
  unit_cost numeric(18,2),
  reference text,
  source text NOT NULL DEFAULT 'manual',   -- manual | grn | disposal
  issued_to text,
  project_id text,
  movement_date date NOT NULL DEFAULT CURRENT_DATE,
  note text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-item currency for inventory valuation.
ALTER TABLE stock_item ADD COLUMN IF NOT EXISTS currency text;

-- Staging for bulk inventory/asset import from a spreadsheet. Parsed rows are held
-- here for review (column mapping + preview) before being written as stock items.
CREATE TABLE IF NOT EXISTS inventory_import (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  status text NOT NULL DEFAULT 'preview',   -- preview | applied | cancelled
  header_json text,        -- JSON array of detected header labels
  mapping_json text,       -- JSON object: field -> source column index (-1 = unmapped)
  rows_json text,          -- JSON array of raw data rows (arrays of cells)
  created_count integer NOT NULL DEFAULT 0,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Generic staging for bulk import of register entities (vendors, contracts, …) from a
-- spreadsheet. Parsed rows are held for review (column mapping + preview) before insert.
CREATE TABLE IF NOT EXISTS import_job (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  entity text NOT NULL,                     -- vendor | contract
  file_name text NOT NULL,
  status text NOT NULL DEFAULT 'preview',   -- preview | applied | cancelled
  header_json text,
  mapping_json text,
  rows_json text,
  created_count integer NOT NULL DEFAULT 0,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================== Disposal management (board of survey workflow) =====================
CREATE TABLE IF NOT EXISTS disposal (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  reference text,
  description text NOT NULL,
  method text NOT NULL DEFAULT 'sale',   -- sale | transfer | donation | destruction | write_off | other
  asset_id text REFERENCES fixed_asset(id) ON DELETE SET NULL,
  stock_item_id text REFERENCES stock_item(id) ON DELETE SET NULL,
  quantity numeric(18,2),
  estimated_value numeric(18,2) NOT NULL DEFAULT 0,
  currency text,
  committee_id text REFERENCES proc_committee(id) ON DELETE SET NULL,
  reason text,
  status text NOT NULL DEFAULT 'draft',  -- draft | submitted | board_survey | approved | rejected | disposed
  board_survey_date date,
  decided_by text, decided_at timestamptz,
  disposed_date date,
  proceeds numeric(18,2),
  note text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================== Tender & bid management =====================
CREATE TABLE IF NOT EXISTS tender (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  reference text,
  title text NOT NULL,
  description text,
  method text NOT NULL DEFAULT 'open_domestic', -- open_domestic | open_international | restricted | rfq | direct | other
  category text NOT NULL DEFAULT 'goods',        -- goods | works | services | consultancy
  estimated_value numeric(18,2) NOT NULL DEFAULT 0,
  currency text,
  committee_id text REFERENCES proc_committee(id) ON DELETE SET NULL,
  advertised_date date,
  closing_date date,
  status text NOT NULL DEFAULT 'draft',  -- draft | advertised | closed | evaluation | awarded | cancelled
  award_bid_id text,
  note text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tender_bid (
  id text PRIMARY KEY,
  tender_id text NOT NULL REFERENCES tender(id) ON DELETE CASCADE,
  vendor_id text REFERENCES vendor(id) ON DELETE SET NULL,
  bidder_name text NOT NULL,
  bid_amount numeric(18,2) NOT NULL DEFAULT 0,
  currency text,
  received_date date,
  status text NOT NULL DEFAULT 'received', -- received | responsive | non_responsive | shortlisted | awarded | rejected
  evaluation_score numeric(10,2),
  evaluation_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================== Contract register (contract management) =====================
CREATE TABLE IF NOT EXISTS contract (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  reference text,
  title text NOT NULL,
  vendor_id text REFERENCES vendor(id) ON DELETE SET NULL,
  provider_name text,
  tender_id text REFERENCES tender(id) ON DELETE SET NULL,
  contract_value numeric(18,2) NOT NULL DEFAULT 0,
  currency text,
  start_date date, end_date date, signed_date date,
  status text NOT NULL DEFAULT 'active',  -- draft | active | suspended | completed | terminated
  scope text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contract_milestone (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  name text NOT NULL,
  due_date date,
  amount numeric(18,2),
  status text NOT NULL DEFAULT 'pending', -- pending | delivered | accepted | delayed
  delivered_date date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contract_payment (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  reference text,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  currency text,
  payment_date date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contract_appraisal (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  period text,
  quality numeric(4,1),      -- 1-5
  timeliness numeric(4,1),   -- 1-5
  compliance numeric(4,1),   -- 1-5
  comments text,
  appraised_by text,
  appraisal_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Track how much of each PO line has been posted to stores/asset register (avoids double-posting).
ALTER TABLE purchase_order_item ADD COLUMN IF NOT EXISTS posted_qty numeric(18,2) NOT NULL DEFAULT 0;

-- ===================== Budget approval workflow + reallocations (virement) =====================
CREATE TABLE IF NOT EXISTS budget_approval (
  id text PRIMARY KEY,
  budget_id text NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  action text NOT NULL,              -- submitted | approved | rejected | reopened
  note text,
  acted_by_id text, acted_by_name text,
  acted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS budget_reallocation (
  id text PRIMARY KEY,
  budget_id text NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  from_line_id text NOT NULL,
  to_line_id text NOT NULL,
  amount double precision NOT NULL DEFAULT 0,
  reason text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================== Lab: visits/timepoints, collection origin, freeze-thaw =====================
-- A visit groups a participant's samples by timepoint (Day 0, Visit 1, ...) for repeat sampling.
CREATE TABLE IF NOT EXISTS lab_visit (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  participant_id text NOT NULL REFERENCES lab_participant(id) ON DELETE CASCADE,
  label text NOT NULL,                 -- 'Day 0', 'Visit 1', 'Baseline'
  visit_date date,
  sequence int,                        -- optional ordering / timepoint number
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (participant_id, label)
);
ALTER TABLE lab_sample ADD COLUMN IF NOT EXISTS visit_id text REFERENCES lab_visit(id) ON DELETE SET NULL;
ALTER TABLE lab_sample ADD COLUMN IF NOT EXISTS collection_facility text;
ALTER TABLE lab_sample ADD COLUMN IF NOT EXISTS collection_district text;
ALTER TABLE lab_sample ADD COLUMN IF NOT EXISTS collection_site text;
ALTER TABLE lab_sample ADD COLUMN IF NOT EXISTS freeze_thaw_count int NOT NULL DEFAULT 0;
ALTER TABLE lab_sample_type ADD COLUMN IF NOT EXISTS max_freeze_thaw int;   -- acceptable freeze-thaw cycles for this analyte
ALTER TABLE lab_retrieval ADD COLUMN IF NOT EXISTS thawed boolean NOT NULL DEFAULT false;

-- ===================== Lab: freezer register + temperature logs + incidents (cold chain) =====================
CREATE TABLE IF NOT EXISTS lab_freezer (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,                        -- 'FZR-01'
  location text,                              -- room / lab
  kind text NOT NULL DEFAULT 'freezer_-80',  -- freezer_-80 | freezer_-20 | fridge_4 | ln2 | cold_room | other
  set_point double precision,                -- target temperature (°C)
  min_temp double precision,                 -- acceptable range low
  max_temp double precision,                 -- acceptable range high
  asset_id text,                             -- optional link to fixed_asset
  status text NOT NULL DEFAULT 'active',     -- active | maintenance | decommissioned
  notes text,
  created_by_id text, created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE TABLE IF NOT EXISTS lab_temp_log (
  id text PRIMARY KEY,
  freezer_id text NOT NULL REFERENCES lab_freezer(id) ON DELETE CASCADE,
  reading_at timestamptz NOT NULL DEFAULT now(),
  temperature double precision NOT NULL,
  min_reading double precision,              -- optional daily min/max thermometer values
  max_reading double precision,
  in_range boolean NOT NULL DEFAULT true,
  note text,
  recorded_by_id text, recorded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lab_freezer_incident (
  id text PRIMARY KEY,
  freezer_id text NOT NULL REFERENCES lab_freezer(id) ON DELETE CASCADE,
  incident_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL DEFAULT 'other',        -- power_outage | alarm | excursion | mechanical | door_open | defrost | other
  severity text NOT NULL DEFAULT 'warning',  -- info | warning | critical
  description text,
  action_taken text,
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  reported_by_id text, reported_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===================== Lab: test/assay catalogue + per-sample tests & results =====================
CREATE TABLE IF NOT EXISTS lab_assay (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text,                              -- Molecular | Serology | Hematology | Microscopy | Chemistry | Other
  method text,                                -- default method
  unit text,                                  -- default result unit (quantitative)
  turnaround_days int,
  status text NOT NULL DEFAULT 'active',      -- active | inactive
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE TABLE IF NOT EXISTS lab_test (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  sample_id text NOT NULL REFERENCES lab_sample(id) ON DELETE CASCADE,
  assay_id text REFERENCES lab_assay(id) ON DELETE SET NULL,
  assay_name text,                            -- denormalized / ad-hoc
  status text NOT NULL DEFAULT 'requested',   -- requested | in_progress | completed | cancelled | failed
  requested_by_id text, requested_by_name text,
  requested_date date,
  method text,
  result text,                                -- qualitative result or value summary
  result_numeric double precision,
  unit text,
  interpretation text,                        -- normal | abnormal | positive | negative | inconclusive
  performed_by_id text, performed_by_name text,
  result_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Groups samples disposed together in one bulk disposal event (board-of-survey traceability).
ALTER TABLE lab_sample ADD COLUMN IF NOT EXISTS disposal_batch_id text;

-- Link a sample to a registered freezer so cold-chain excursions/incidents can flag affected samples.
ALTER TABLE lab_sample ADD COLUMN IF NOT EXISTS freezer_id text REFERENCES lab_freezer(id) ON DELETE SET NULL;

-- ===================== Clinical trials: safety (AE/SAE), deviations, monitoring =====================
CREATE TABLE IF NOT EXISTS study_ae (
  id text PRIMARY KEY,
  study_id text NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  participant_ref text,                      -- de-identified subject / screening id
  term text NOT NULL,                        -- event term
  onset_date date,
  severity text NOT NULL DEFAULT 'mild',     -- mild | moderate | severe
  serious boolean NOT NULL DEFAULT false,    -- SAE?
  sae_criteria text,                         -- death | life_threatening | hospitalization | disability | congenital_anomaly | other
  causality text,                            -- unrelated | unlikely | possible | probable | definite
  expectedness text,                         -- expected | unexpected
  outcome text,                              -- recovered | recovering | ongoing | recovered_sequelae | fatal | unknown
  action_taken text,
  reported_date date,                        -- date reported to authority
  reported_to text,                          -- REC | NDA | sponsor | other
  status text NOT NULL DEFAULT 'open',       -- open | followed_up | reported | resolved
  description text,
  recorded_by_id text, recorded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS study_deviation (
  id text PRIMARY KEY,
  study_id text NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  participant_ref text,
  deviation_date date,
  kind text NOT NULL DEFAULT 'other',        -- eligibility | consent | visit_window | procedure | ip_handling | sae_reporting | other
  severity text NOT NULL DEFAULT 'minor',    -- minor | major
  description text NOT NULL,
  root_cause text,
  corrective_action text,
  reported boolean NOT NULL DEFAULT false,
  reported_date date,
  status text NOT NULL DEFAULT 'open',        -- open | capa | resolved
  recorded_by_id text, recorded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS study_monitoring (
  id text PRIMARY KEY,
  study_id text NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  visit_date date,
  kind text NOT NULL DEFAULT 'imv',          -- siv | imv | cov | for_cause | remote
  monitor_name text,
  site text,
  findings text,
  action_items text,
  report_received boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open',        -- scheduled | open | actions_pending | closed
  recorded_by_id text, recorded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);


-- ===================== Direct messaging (employee-to-employee chat) =====================
-- Both parties are app_users within the same organisation. The people-directory
-- for starting a chat is the active employee list, searchable by name or email.
CREATE TABLE IF NOT EXISTS message (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  from_user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  to_user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_message_pair ON message(org_id, from_user_id, to_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_inbox ON message(to_user_id, read_at);


-- ===================== Refund / reimbursement requests =====================
CREATE TABLE IF NOT EXISTS refund_request (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  expenditure_id text REFERENCES expenditure(id) ON DELETE SET NULL,
  budget_line_id text,
  number text NOT NULL,
  amount double precision NOT NULL,
  reason text,
  requested_by_id text, requested_by_name text, requester_role text,
  requires_pi boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'submitted',   -- submitted | pi_approved | approved | rejected | paid | acknowledged
  pi_decision text, pi_by_id text, pi_by_name text, pi_at timestamptz, pi_comment text,
  finance_decision text, finance_by_id text, finance_by_name text, finance_at timestamptz, finance_comment text,
  paid_at timestamptz, paid_by_id text, paid_by_name text, payment_ref text,
  acknowledged_at timestamptz, acknowledged_note text,
  last_reminded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE refund_request ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;
ALTER TABLE requisition ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;
CREATE TABLE IF NOT EXISTS refund_file (
  id text PRIMARY KEY,
  refund_id text NOT NULL REFERENCES refund_request(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'evidence',      -- evidence | proof
  name text NOT NULL, storage_key text, mime_type text, size_bytes integer,
  uploaded_by text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refund_project ON refund_request(project_id);
CREATE INDEX IF NOT EXISTS idx_refund_file_refund ON refund_file(refund_id);
