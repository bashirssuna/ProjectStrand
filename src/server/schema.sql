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
