# Project Strand

A multi-tenant project-operations platform for **research, grant, NGO, academic, and
implementation projects** — built to take a project from proposal through closeout:
Statement of Work, work plan & Gantt, logical framework, budgets, spending, fund
requisitions with e-signature approval workflows, AI-assisted reporting, document import,
role-based access, and an organisation-wide admin control centre.

This repository is a **runnable foundation with a complete happy-path**, not the entire
commercial product. Core business logic is real (RBAC policy engine, requisition state
machine, budget rollups, anomaly/rule engine, document parsing → record generation,
report generation, audit logging). Heavyweight infrastructure (S3, Resend, BullMQ,
Meilisearch, FullCalendar, tRPC, Playwright) is wired behind clean seams documented below.

### Implemented in this build
- **Upload a SOW** from the Statement of Work tab — a Word/PDF SOW is parsed and mapped onto the
  standard section slots (background, objectives, deliverables, reporting, payment, assumptions).
- **Upload a work plan or Gantt** from the Work plan tab — Word/PDF work plans extract activity
  lines; Excel/CSV Gantt charts with Activity/Start/End columns populate dated activities. The work
  plan can also be **generated from the budget** when no work-plan document exists.
- **Budget currency conversion** — convert an imported budget to the project currency (e.g. USD→UGX)
  by exchange rate, with an optional currency switch.
- **Manual activity entry on requisitions** — type a new activity inline instead of only picking one.
- **Real document upload & parsing** — upload PDF, Word (.docx/.doc), Excel (.xlsx/.xls), CSV or
  text from your computer in the project import flow. Server-side extraction (mammoth / unpdf /
  SheetJS) pulls objectives, outputs, activities and **budget lines** (it reads grant-style
  "Activity Area / N.M line-item" spreadsheets). Uploaded files are stored and filed under the
  project **Documents** with authenticated download links; documents can also be uploaded directly.
- **Automatic, colour-coded activity progress** — parent/roll-up progress is computed from child
  activities (done children pull a parent toward 100%); marking an activity done/not-started snaps
  it to 100/0; every progress bar is colour-coded by completion.
- **Report export to Word (.docx)** — one-click download with the narrative sections, a computed
  work-plan analysis, and colour bar-charts for activity progress, indicators-vs-target and budget burn.
- **Multi-currency** including **UGX** (plus KES/TZS/RWF/USD/EUR/GBP/NGN/ZAR).

---

## Tech stack (as built)

| Concern | Choice | Notes |
|---|---|---|
| Framework | **Next.js 15** (App Router, RSC, Server Actions) + TypeScript | Server components fetch data directly; mutations go through typed server actions. |
| UI | Tailwind CSS v3 + a small in-repo component kit | CSS-variable theming, light/dark, editorial/institutional design language. |
| Database | **PostgreSQL** | In local/dev this repo runs **PGlite** (`@electric-sql/pglite`), a pure-WASM Postgres, so it boots with zero external services. The SQL is standard Postgres. |
| Data access | Hand-written SQL via a tiny typed `q()/one()` helper | No ORM at runtime. `prisma/schema.prisma` is kept **as a model document** for porting to Prisma + managed Postgres. |
| Auth | Signed-cookie sessions (HMAC) + scrypt password hashing | Drop-in seam for Better Auth / Auth.js — see below. |
| Validation | Zod (available) + server-side guards on every mutation | |
| Charts/Gantt | Hand-rolled SVG (`components/gantt.tsx`) + progress bars | No chart dependency required; swap for Recharts/ECharts freely. |

### Why PGlite locally
The build environment had no Postgres server and blocked Prisma's engine-binary download
and native `better-sqlite3` builds. PGlite is pure WASM (installs from npm only) and speaks
real Postgres SQL, so the app boots, migrates, seeds, and serves with **no external
dependencies**. Moving to managed Postgres in production is a connection-string change plus
swapping the `getDb()` driver (see `src/server/db.ts`).

---

## Quick start

```bash
# 1. Install
npm install

# 2. Create the database and load realistic demo data
#    (creates ./.pgdata, applies src/server/schema.sql, runs the seed)
npm run db:reset

# 3. Run
npm run dev          # http://localhost:3000
# or, production mode:
npm run build && npm start
```

### Demo logins (password for all: `password123`)

| Email | Role | What to look at |
|---|---|---|
| `admin@strand.dev` | Platform admin | `/admin` — sees every org/project, all flags, system audit log |
| `pi@strand.dev` | Principal Investigator | Full project control |
| `pm@strand.dev` | Project Manager | **Has REQ-0002 awaiting signature** on the dashboard |
| `finance@strand.dev` | Finance Administrator | Budget, spending, requisition approvals |
| `coord@strand.dev` | Project Coordinator | Runs activities, raises requisitions |
| `assistant@strand.dev` | Research Assistant | Updates assigned work |

The seed builds one fully-populated project — *Climate-Resilient Smallholder Agriculture in
the Rift Valley* (donor: Global Climate Fund) — with SOW, objectives/indicators, a work-plan
tree + milestones, a 10-line budget, expenditures (including **deliberate anomalies**), three
requisitions at different workflow stages, a quarterly report, documents, meetings, and risks.

---

## The happy path (end-to-end, all implemented)

1. **Create project** — `/projects/new` wizard (basics, donor, dates, simple/advanced mode).
2. **Import documents** — paste a proposal (a *Load sample* button is provided); the parser
   extracts objectives, outputs, activities and budget lines.
3. **Review & approve extraction** — `/projects/[id]/import/[jobId]` shows every suggestion
   with a confidence score and checkboxes; accepted items are materialised into real records.
   Nothing is auto-finalised.
4. **Assign team** — `/projects/[id]/team` invites members by email (creates an *invited*
   account + notification) and sets per-project roles.
5. **Build the work plan** — `/projects/[id]/workplan`: activity tree, inline status/progress
   editing, and an SVG Gantt with a "today" line and milestone markers.
6. **Build the budget** — `/projects/[id]/budget`: line items with planned/committed/actual/
   remaining rollups and burn bars.
7. **Raise a requisition** — `/projects/[id]/requisitions`: linked to an activity & budget
   line, with justification and payee.
8. **Approve & sign** — submit routes it through the configurable approval matrix
   (finance → PM → admin by amount threshold). Approvers **sign with their stored signature
   image**; full approval reserves funds via a commitment.
9. **Record expenditure** — disburse, then retire/account for the requisition; the commitment
   is released and the **anomaly engine re-runs**.
10. **Generate a report** — `/projects/[id]/reports` drafts a narrative report from live data
    (activities, indicators, budget, flags); editable, and emailable to the team.

Throughout, the **anomaly/rule engine** flags over-budget lines, negative balances, budget
decreases after commitments, out-of-period spend, wrong-line spend, missing approvals,
duplicate references, unusually high unit costs, and requisitions exceeding available funds.
Flags surface on the project overview, the dashboard, and the admin centre.

---

## Architecture

```
src/
  app/
    (app)/                     # authenticated shell (sidebar, topbar, project switcher)
      dashboard/               # portfolio overview, things-to-sign, notifications
      projects/                # list, new-project wizard
      projects/[id]/           # project workspace
        layout.tsx             # tabbed subnav + project.view access gate
        page.tsx               # overview: KPIs, health score, anomaly flags, risks
        import/[jobId]/        # document parse → review → generate
        sow/ workplan/ logframe/ budget/ spending/
        requisitions/[reqId]/  # approval chain + e-signature + disburse/retire
        reports/ documents/ team/
      profile/                 # details, signature pad, my work, my approvals
      admin/                   # org-wide control centre (super_admin only)
    login/                     # split-screen login
    actions.ts                 # ALL server actions (auth-guarded mutations)
    globals.css                # design tokens + component classes
  components/                  # ui kit, nav, gantt, import form, signature pad, theme toggle
  lib/                         # ids, enums (single source of truth), formatters, password
  server/
    db.ts                      # PGlite singleton + q()/one()/exec() helpers
    schema.sql                 # the live Postgres DDL (≈40 tables, idempotent)
    auth.ts  policy.ts  email.ts
    services/                  # domain modules:
      projects budget anomaly(+core) requisitions parsing reports audit
scripts/seed.ts                # realistic demo data + happy-path state
prisma/schema.prisma           # model documentation (not used at runtime)
```

### Permissions model
Two layers, policy-based (not bare role checks):
- **System roles**: `super_admin`, `org_admin`, `support_admin`.
- **Project roles**: `pi`, `project_manager`, `finance_admin`, `coordinator`, `assistant`,
  `member`, `reviewer`, `approver`, `viewer`.

`src/lib/enums.ts` maps roles → permission sets (`project.edit`, `budget.manage`,
`requisitions.approve`, `members.manage`, …). `src/server/policy.ts` resolves a user's
effective permissions on a project (role defaults ∪ explicit overrides ∪ org/super-admin
escalation) and exposes `can()` / `requirePermission()`. **Every server action calls
`requirePermission` before mutating** — the client is never trusted for authorisation.

### Auditing
`writeAudit()` records actor, action, entity, and before/after metadata for sensitive
operations (approvals, signatures, role changes, imports, expenditures). Viewable per-project
and org-wide in the admin centre.

---

## Production seams (swap-in points)

Everything below is abstracted so production wiring is localised. Toggle via env vars in
`.env`:

| Capability | Local (now) | Production swap |
|---|---|---|
| Database | PGlite (`.pgdata`) | Managed Postgres — change `getDb()` in `src/server/db.ts` to `pg`/`postgres.js`; SQL is unchanged. Optionally adopt the included `prisma/schema.prisma`. |
| Auth | Signed-cookie HMAC sessions | `Better Auth` / `Auth.js` / Clerk — replace `src/server/auth.ts` (`getCurrentUser/createSession`); `policy.ts` consumes the user unchanged. |
| Email | `EMAIL_PROVIDER=console` (logs to stdout) | `resend` / `postmark` / `sendgrid` — implement `sendEmail()` in `src/server/email.ts`. ICS generation (`buildICS`) is already RFC-5545. |
| File storage | metadata-only records | `STORAGE_PROVIDER=s3` — add signed-upload URLs + virus-scan hook; document records already carry `storage_key`. |
| Document parsing | `AI_PROVIDER=heuristic` (regex/table extraction) | `AI_PROVIDER=anthropic` — replace `parseDocument()` and report drafting with an LLM pass behind the same `Suggestion[]` interface; DOCX/XLSX/PDF text extraction server-side. |
| Background jobs | inline | **BullMQ** workers for reminders, approval nudges, scheduled report prompts, parsing. |
| Search | (per-page SQL) | Postgres full-text or **Meilisearch** indexing. |
| Calendar UI | in-app + ICS links | **FullCalendar** front-end. |
| Charts | SVG | **Recharts/ECharts**. |
| API surface | server actions + RSC | add **tRPC**/REST handlers reusing the same `services/`. |
| Tests | — | **Vitest** (services) + **Playwright** (happy-path E2E). |

---

## Environment variables (`.env`)

```
AUTH_SECRET=dev-secret-change-me      # HMAC session signing key (set a strong value in prod)
APP_URL=http://localhost:3000
EMAIL_PROVIDER=console                # console | resend | postmark | sendgrid
STORAGE_PROVIDER=local                # local | s3
AI_PROVIDER=heuristic                 # heuristic | anthropic
# DATABASE_URL=postgresql://user:pass@host:5432/strand   # for the managed-Postgres swap
```

## Scripts

```
npm run dev        # Next dev server
npm run build      # production build
npm start          # serve the production build
npm run db:seed    # apply schema + load demo data
npm run db:reset   # wipe ./.pgdata and reseed
```

## Deployment

- **Frontend + server actions**: Vercel (Next.js native). Set env vars in the project.
- **Database**: any managed Postgres (Neon, Supabase, RDS, Railway, Fly). Apply
  `src/server/schema.sql`, point `DATABASE_URL` at it, and switch the `getDb()` driver.
- **Workers/email/storage**: Railway / Fly / Render for BullMQ workers and an S3-compatible
  bucket; configure the provider env vars.

---

## Verification status (honest)

- `next build` **passes** — all 21 routes compile and type-check.
- The seed runs end-to-end and produces the expected records and anomaly flags.
- Runtime server boots, authentication and the project access gate work, and pages render.
- A runtime smoke test caught and fixed one latent SQL bug (a budget rollup referenced a
  column on the wrong table). The fix is in `src/server/services/budget.ts`.

Not yet built: the heavyweight integrations listed under **Production seams**, and the
automated test suites. Those are the natural next milestones.

---

## Deployment & going commercial

### Local development
No setup beyond `npm install`. The app uses **PGlite** (an in-process Postgres saved to `./.pgdata`) and writes uploads to `./.uploads`, so it runs with zero external services:

```bash
npm install
npm run db:reset   # creates schema + demo org/users/project
npm run dev        # http://localhost:3000
```

### Choosing a host
This is a Next.js (App Router) app that needs **(a) a persistent Postgres** and **(b) persistent file storage** for uploads. That shapes the choice:

| Host | Verdict |
|------|---------|
| **Railway / Render** | **Easiest full deploy.** Long-running Node server = uploads work on a persistent disk, and both offer a managed Postgres add-on. Recommended if you want everything working with the least wiring. |
| **Vercel** | Excellent for the app itself, but functions are **stateless** — you must use an external Postgres (**Neon**/Supabase) *and* external object storage (**Cloudflare R2 / S3**) for uploads. Best for scale. |
| **HostGator** | **Not suitable** for this stack (shared cPanel is built for PHP/MySQL, no good Node/Postgres story). Use it only for your marketing domain or email if you like, and point the app's domain (CNAME) at Railway/Render/Vercel. |

### Production environment variables
Set these in your host's dashboard (see `.env.example`):

```
AUTH_SECRET=<32+ random bytes>
APP_URL=https://app.yourdomain.com
DATABASE_URL=postgres://user:pass@host/db?sslmode=require   # Neon/Supabase/Railway/Render
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxx
EMAIL_FROM="Project Strand <noreply@yourdomain.com>"
TRIAL_DAYS=90
```

When `DATABASE_URL` is set the app automatically uses a pooled `pg` connection instead of PGlite — the SQL is identical.

### Deploy steps (Vercel + Neon example)
1. Create a Neon Postgres project; copy the **pooled** connection string.
2. Push the schema once: `DATABASE_URL=<neon-url> npm run db:push`
3. Import the repo into Vercel; add the env vars above; deploy.
4. (Uploads) Create a Cloudflare R2 bucket and wire `src/server/services/storage.ts` to it (the `saveUpload`/`readUpload` seam is already isolated). On Railway/Render you can skip this — the local-disk path works on the persistent volume.

### Deploy steps (Railway/Render example)
1. New service from the repo; build `npm run build`, start `npm run start`.
2. Add a managed Postgres; set `DATABASE_URL` from it.
3. Add a persistent volume mounted at the project dir (so `./.uploads` survives restarts).
4. Run `npm run db:push` once (Railway: a one-off command) to create the schema.

### Multi-tenancy (already built in)
- **Organizations are isolated.** Each org's members and org-admins see **only their own org's projects**; the org-admin sees all projects in their org, regular members see only the projects they're on.
- The **platform super-admin** (`admin@strand.dev` in the seed — change this) is *your* operator account and can see every organization. Create more platform admins from the Admin area.
- **Self-serve signup** at `/signup` creates a new organization on a **free trial** (length = `TRIAL_DAYS`, default ~3 months), with the signer as that org's admin. They can then invite their team and add PIs.
- A trial banner shows days remaining; once expired, project creation is blocked until upgrade.

### Turning the trial into revenue (next step)
The trial fields (`organization.plan`, `trial_ends_at`, `status`) are in place. To charge: add **Stripe Checkout** + a webhook that, on successful subscription, sets `plan='active'` (and on cancellation/expiry, back to `trial`/suspended). A `/billing` page for org-admins (plan, seats, invoice history) is the natural home for it.

---

## Deploy to Render — step by step (Web Service, NOT Static Site)

> Project Strand is a dynamic Next.js app (server actions + API + database). It must be a
> **Web Service**, not a Static Site. A Static Site returns "Not Found" because there is no
> static HTML to serve.

### Option A — Blueprint (easiest, uses `render.yaml`)
1. Push this repo to GitHub.
2. Render Dashboard → **New +** → **Blueprint** → select the repo. Render reads `render.yaml`
   and creates a **Web Service** + a **Postgres** database, generating `AUTH_SECRET` and wiring
   `DATABASE_URL` automatically.
3. Click **Apply**. First build runs `npm install && npm run build`, then `npm run start`.
4. Open the service URL (e.g. `https://project-strand.onrender.com`) → the login page loads.
5. Create your first organisation at `/signup` (3-month trial), **or** load demo data: service →
   **Shell** → `npm run db:seed` (gives the demo accounts, password `password123`).

### Option B — Manual (fix your current service)
Your current service is a *Static Site* — that type can't run this app. Create a new one:
1. **New +** → **Web Service** → connect the repo.
2. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm run start`   ← this runs `next start` (do **not** set a publish dir)
   - **Health Check Path:** `/login`
3. **New +** → **Postgres** → create a database; copy its **Internal Connection String**.
4. Back in the Web Service → **Environment** → add:
   - `DATABASE_URL` = the Postgres connection string
   - `AUTH_SECRET` = a long random string (`openssl rand -hex 32`)
   - `NODE_VERSION` = `22`
   - (optional email) `EMAIL_PROVIDER=resend`, `RESEND_API_KEY=…`, `EMAIL_FROM="Project Strand <noreply@yourdomain>"`
5. **Manual Deploy** → **Deploy latest commit**. When live, open the URL and sign up / seed.
6. Delete the old Static Site.

### Notes
- The app **creates its own schema on first DB connection** — no manual migration needed. (You can
  also run `npm run db:push` from the Shell to pre-create it.)
- Render's **free** Web Service sleeps after inactivity (slow first load) and the **free** Postgres
  expires after ~30 days — fine for testing; use paid instances for production.
- Email links auto-use Render's `RENDER_EXTERNAL_URL`, so invite/reset links work without setting
  `APP_URL`.
- **Uploads:** the free Web Service has an ephemeral disk, so uploaded files don't survive restarts.
  For durable uploads, attach a Render **Disk** (mount at the project dir) or wire S3/R2 in
  `src/server/services/storage.ts`.
