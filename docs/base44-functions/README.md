# Base44 Functions — Parity Reference

Reference copies of Base44 Deno edge functions deployed in the Base44 dashboard.
Netlify equivalents live under `netlify/functions/` when the flow is mirrored on
the static site side.

## Base44 git repo (deploy source of truth)

| Item | Value |
|------|-------|
| Git remote | `https://github.com/palmtr3man/career-navigator.git` |
| Deploy tree | `base44/functions/<FunctionName>/entry.ts` |
| App ID | `67912f60b0c40c4f1a48d1c7` |
| Admin UI | `src/components/tower/NextFlightConfigPanel.jsx` (AutoPilot toggle) |
| Sync manifest | `scripts/base44-git-sync-manifest.ts` |

Base44 Dashboard → Git integration should point at **career-navigator**, not this
`.com` repo. Files under `base44-functions/` here are parity/reference copies;
promote changes to career-navigator before expecting a Base44 sync deploy.

Smoke test (logic guards):

```bash
node test-auto-pilot-boarding-send.cjs
```

Career-navigator canonical test:

```bash
node scripts/test-auto-pilot-boarding-send.mjs
```

## createAdminPassenger

| Surface | Path |
|---------|------|
| Base44 (deploy target) | `base44-functions/createAdminPassenger.ts` |
| Netlify | `POST /api/create-admin-passenger` → `netlify/functions/create-admin-passenger.js` |

### Purpose

Admin-only passenger creation with a **pre-assigned seat ID**. Does **not** trigger
the public `/api/seat-request` intake chain.

### Request payload

```json
{
  "name": "Jane Clark",
  "email": "jane@example.com",
  "seat_id": "TUJ-JA2222",
  "flight_id": "FL_051126",
  "first_name": "Jane",
  "cabin_class": "Economy",
  "send_invite": false
}
```

### Response

```json
{
  "ok": true,
  "passenger_id": "uuid-or-base44-id",
  "created": true,
  "seat_id": "TUJ-JA2222",
  "flight_id": "FL_051126",
  "user_updated": false,
  "invite_sent": false,
  "base44_synced": true,
  "supabase_synced": true
}
```

Netlify returns `base44_synced`; Base44 returns `supabase_synced`.

### Auth

| Surface | Mechanism |
|---------|-----------|
| Base44 | `base44.auth.me()` — caller must have `role === 'admin'` |
| Netlify | `SEC06_INTERNAL_TOKEN` via `x-internal-token` or `Authorization: Bearer` |

### Dual-write matrix

| Write target | Base44 function | Netlify function |
|--------------|-----------------|------------------|
| Base44 Passenger | Primary | Optional (`BASE44_PASSENGER_URL`) |
| Supabase `passengers` | Optional (`SUPABASE_URL` + service role) | Primary |
| Base44 User `passport_seat_id` | Yes (entity filter) | Optional (`BASE44_USER_URL`) |
| AuditLog entity | Yes (`writeAuditLog`) | Structured console log |
| Intake invite email | `SENDGRID_TEMPLATE_INTAKE` (alias: `INVITE_TEMPLATE_ID`) | `SENDGRID_TEMPLATE_INTAKE` |

### intake_status vocabulary

Base44 Passenger entity uses `not_invited` → `invited`.

Supabase `public.passengers.intake_status` check constraint allows
`pending`, `complete`, `rejected`. The Netlify port writes `pending` for
pre-board admin creates; invite send does not change the Supabase row.

### Required env — Base44 deploy

```
SENDGRID_API_KEY
SENDGRID_FROM_EMAIL
APP_BASE_URL
SENDGRID_TEMPLATE_INTAKE          # canonical; INVITE_TEMPLATE_ID accepted as alias
SENDGRID_UNSUBSCRIBE_GROUP_TRANSACTIONAL
SUPABASE_URL                  # optional dual-write
SUPABASE_SERVICE_ROLE_KEY     # optional dual-write
```

### Required env — Netlify

```
SEC06_INTERNAL_TOKEN
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Optional:

```
BASE44_PASSENGER_URL
BASE44_USER_URL
BASE44_API_KEY
SENDGRID_API_KEY
SENDGRID_FROM_EMAIL
SENDGRID_TEMPLATE_INTAKE
SITE_URL
SENDGRID_UNSUBSCRIBE_GROUP_TRANSACTIONAL
```

### Deploy checklist

1. Copy `base44-functions/createAdminPassenger.ts` and `base44-functions/shared/*` into Base44 Dashboard → Code → Functions.
2. Set Base44 function env vars (see above).
3. Set matching Netlify env vars for dual-write parity.
4. Smoke test Netlify: `node test-create-admin-passenger.cjs`
5. Call Base44 function URL from Mission Control with admin session token.

### curl — Netlify

```bash
curl -sS -X POST "$SITE/api/create-admin-passenger" \
  -H "Content-Type: application/json" \
  -H "x-internal-token: $SEC06_INTERNAL_TOKEN" \
  -d '{
    "name": "Jane Clark",
    "email": "jane@example.com",
    "seat_id": "TUJ-JA2222",
    "flight_id": "FL_051126",
    "send_invite": false
  }'
```

## Security scan — exposed env vars (Jul 2026)

Base44's security scan flags backend env vars that are not in the
platform-managed secrets whitelist. Remediation has two parts:

1. **Code** — read values via `firstRequiredEnv(...ENV_ALIASES.*)` from
   `shared/config.ts` + `shared/platformSecrets.ts` (never hardcode).
2. **Vault** — store values with `base44 secrets set` using the **canonical**
   name from the table below.

| Function | Flagged var | Canonical name | Aliases still accepted |
|----------|-------------|----------------|------------------------|
| `createAdminPassenger` | invite template ID | `SENDGRID_TEMPLATE_INTAKE` | `INVITE_TEMPLATE_ID` |
| `migrateSeatIds` | seat IDs map | `MIGRATION_SEAT_IDS_MAP` | `MIGRATION_SEAT_IDS`, `MIGRATE_SEAT_IDS_MAP` |
| `notifyTaskFailure` | alert recipient | `TASK_FAILURE_ALERT_EMAIL` | `TASK_FAILURE_EMAIL` |
| `syncPassengerPipeline` | Notion pipeline DB | `NOTION_SEAT_DB_ID` | `NOTION_PASSENGER_PIPELINE_DB_ID`, `NOTION_PIPELINE_DATABASE_ID` |
| `syncBmacMembers` | Alpha / Beta product IDs | `BMAC_ALPHA_PRODUCT_ID`, `BMAC_BETA_PRODUCT_ID` | — |
| `syncPassportSeatId` | pilot TUJ code | `DEMO_SEAT_ID` | `PILOT_USER_TUJ_CODE`, `PILOT_SEAT_ID` |
| `patchUserSeatId` | pilot TUJ code (admin self-test) | `DEMO_SEAT_ID` | `PILOT_USER_TUJ_CODE`, `PILOT_SEAT_ID` |
| `getCohortStatus` | active flight fallback (other functions) | `ACTIVE_FLIGHT_ID` | `ACTIVE_FLIGHT_CODE` |
| `sendgridTemplateData` | active flight fallback | `ACTIVE_FLIGHT_ID` | `ACTIVE_FLIGHT_CODE` |
| `patchAlphaSeats` | *(removed)* | — | PII manifest now loaded from Passenger entities or POST body |

### Deploy patched functions

Reference copies in this repo:

| Function | Reference file |
|----------|----------------|
| `createAdminPassenger` | `base44-functions/createAdminPassenger.ts` |
| `autoPilotBoardingSend` | `base44-functions/autoPilotBoardingSend.ts` |
| `boardingDispatch` | `base44-functions/boardingDispatch.ts` |
| `handleSeatOpened` | `base44-functions/handleSeatOpened.ts` |
| `handleBmacWebhook` | `base44-functions/handleBmacWebhook.ts` |
| `sendgridTemplateData` | `base44-functions/sendgridTemplateData.ts` |
| `notifyTaskFailure` | `base44-functions/notifyTaskFailure.ts` |
| `migrateSeatIds` | `base44-functions/migrateSeatIds.ts` |
| `syncPassengerPipeline` | `base44-functions/syncPassengerPipeline.ts` |
| `syncBmacMembers` | `base44-functions/syncBmacMembers.ts` |
| `patchUserSeatId` | `base44-functions/patchUserSeatId.ts` |
| Shared helpers | `base44-functions/shared/*` |

Promote changes to **career-navigator** (`base44/functions/*/entry.ts`) before Base44 git sync deploys.

```bash
base44 secrets set \
  SENDGRID_TEMPLATE_INTAKE=d-... \
  MIGRATION_SEAT_IDS_MAP='{"old":"new"}' \
  TASK_FAILURE_ALERT_EMAIL=ops@example.com \
  NOTION_SEAT_DB_ID=... \
  BMAC_ALPHA_PRODUCT_ID=... \
  BMAC_BETA_PRODUCT_ID=... \
  DEMO_SEAT_ID=TUJ-KC1111 \
  ACTIVE_FLIGHT_ID=FL_051126
```

Remove `ALPHA_MANIFEST_JSON` from Base44 function env after deploying `patchAlphaSeats` — manifest PII now lives in Passenger records.

Re-run the Base44 security scan after deploy to confirm all findings clear.

## autoPilotBoardingSend

| Surface | Path |
|---------|------|
| Base44 (deploy target) | `base44-functions/autoPilotBoardingSend.ts` |
| Netlify | — (entity automation runs on Base44 only) |

### Purpose

Entity automation handler wired to Seat `status → opened`. When
`NextFlightConfig.auto_pilot_enabled` is true, calls `sendSeatConfirmation`
from `boardingDispatch.ts` in-process (no HTTP / internal-token hop).

Skips when AutoPilot is disabled, status is not `opened`,
`boarding_confirmation_sent_at` is already set, or `user_email` is missing.

### Automation payload

Base44 entity automation event shape:

```json
{
  "event": { "type": "entity.updated", "entity_id": "seat-uuid" },
  "data": { "id": "seat-uuid", "status": "opened", "user_email": "...", "cabin_class": "Economy" }
}
```

When `payload_too_large` is true or `data` is absent, the function fetches the
Seat by `event.entity_id`.

### Auth

| Surface | Mechanism |
|---------|-----------|
| Base44 automation | `rejectBrowserOrigin` — blocks browser `Origin` header only (no internal token) |

### Deploy checklist

1. Copy `base44-functions/autoPilotBoardingSend.ts`, `base44-functions/boardingDispatch.ts`, `base44-functions/handleSeatOpened.ts`, `base44-functions/sendgridTemplateData.ts`, and `base44-functions/shared/*` into Base44 Dashboard → Code → Functions.
2. Add `auto_pilot_enabled` (boolean) to the `NextFlightConfig` entity schema.
3. Wire a Seat entity automation: trigger on `status` change → `opened`, action → invoke `autoPilotBoardingSend`.
4. Ensure SendGrid env vars are set (see handleSeatOpened section — shared via `boardingDispatch.ts`).
5. Enable AutoPilot in Admin → Next Flight Config when ready for live sends.

## handleSeatOpened

| Surface | Path |
|---------|------|
| Base44 (deploy target) | `base44-functions/handleSeatOpened.ts` |
| Shared payload builders | `base44-functions/sendgridTemplateData.ts` |
| Netlify | `POST /api/sendgrid-integration` → `netlify/functions/sendgrid-integration.js` |

### Purpose

Dispatches the dual boarding email sequence when a Seat entity is activated.
Stamps `boarding_confirmation_sent_at` on the Seat record after both sends succeed.
Idempotent via existing stamp + dispatch lease guard.

### Boarding paths

| Path | Templates (in order) |
|------|----------------------|
| Economy / free | `boarding_pass_free_v1` → `boarding_instructions_free_v1` |
| First / paid | `boarding_pass_paid_v1` → `boarding_instructions_paid_v1` |
| VIP | `vip_boarding_pass_v1` → `vip_boarding_instructions_v1` |
| Alpha legacy | `alphaflightannouncement_v1` → `boarding_confirmation_v1` |

Path selection logic lives in `sendgridTemplateData.ts` (`resolveBoardingPath`).

### Request payload

Full Seat entity JSON (same shape Netlify `sendgrid-integration` accepts):

```json
{
  "id": "base44-seat-record-id",
  "tuj_code": "TUJ-KC2222",
  "user_email": "passenger@example.com",
  "first_name": "Kevin",
  "last_name": "Clark",
  "cabin_class": "Economy",
  "boarding_type": "standard",
  "flight_code": "FL_051126"
}
```

### Response

```json
{ "ok": true, "skipped": false, "dry_run": false, "path": "free" }
```

### Auth

| Surface | Mechanism |
|---------|-----------|
| Base44 | `SEC06_INTERNAL_TOKEN` via `x-internal-token` or `Authorization: Bearer` |
| Netlify | Same internal token via `validateInternalTrigger` / SEC-06 guard |

### Required env — Base44 deploy

```
SENDGRID_API_KEY
SENDGRID_FROM_EMAIL
APP_BASE_URL
SEC06_INTERNAL_TOKEN
SENDGRID_TEMPLATE_BOARDING_PASS_FREE
SENDGRID_TEMPLATE_BOARDING_PASS_PAID
SENDGRID_TEMPLATE_BOARDING_INSTRUCTIONS_FREE
SENDGRID_TEMPLATE_BOARDING_INSTRUCTIONS_PAID
SENDGRID_TEMPLATE_VIP_BOARDING_PASS
SENDGRID_TEMPLATE_VIP_BOARDING_INSTRUCTIONS
```

Optional:

```
SENDGRID_TEMPLATE_ALPHA_FLIGHT_ANNOUNCEMENT
SENDGRID_TEMPLATE_BOARDING_CONFIRMATION
SENDGRID_UNSUBSCRIBE_URL
ACTIVE_FLIGHT_CODE
ACTIVE_FLIGHT_DEPARTURE_DATE
BOARDING_CONFIRMATION_DISPATCH_LEASE_MS
BOARDING_DRY_RUN=true
```

Template IDs resolve from env with canonical fallbacks in `sendgridTemplateData.ts`
(aligned with `netlify/functions/sendgrid-templates.js`).

### Deploy checklist

1. Copy `base44-functions/boardingDispatch.ts`, `base44-functions/handleSeatOpened.ts`, `base44-functions/sendgridTemplateData.ts`, and `base44-functions/shared/*` into Base44 Dashboard → Code → Functions (or promote via career-navigator git sync — see top of this doc).
2. Set Base44 function env vars (see above).
3. Smoke test with `BOARDING_DRY_RUN=true` first.
4. Set `BASE44_HANDLE_SEAT_OPENED_URL` on Netlify to the Base44 function URL — `seat-ready`, `seat-activate`, and `admin-approve` route through `netlify/functions/shared/handle-seat-opened-trigger.js` when this var is set.

### curl — Base44 function URL

```bash
curl -sS -X POST "$BASE44_HANDLE_SEAT_OPENED_URL" \
  -H "Content-Type: application/json" \
  -H "x-internal-token: $SEC06_INTERNAL_TOKEN" \
  -d '{
    "id": "seat-record-id",
    "tuj_code": "TUJ-KC2222",
    "user_email": "passenger@example.com",
    "first_name": "Kevin",
    "last_name": "Clark",
    "cabin_class": "Economy"
  }'
```

## handleBmacWebhook

| Surface | Path |
|---------|------|
| Base44 (deploy target) | `base44-functions/handleBmacWebhook.ts` |
| Netlify | — (BMAC posts directly to Base44 function URL) |

### Purpose

Confirms BMAC (Buy Me a Coffee) payment webhooks and propagates the cabin class
chosen at checkout time (Option A contract) to `User.cabin_class`,
`PassengerFlight.bmac_payment_confirmed`, `Subscription.tier`, and
`Seat.bmac_payment_confirmed` (unblocks `seat-activate` Gap 6).

See also: `docs/cabin-selection-bmac-contract.md`

### Preconditions (Cabin Selection UI)

Before redirecting the passenger to BMAC checkout, the UI must write:

| Field | Value |
|-------|-------|
| `PassengerFlight.cabin` | `'Economy'` \| `'Business'` \| `'First'` |
| `PassengerFlight.bmac_payment_confirmed` | `false` |

### BMAC events handled

| Event | Meaning |
|-------|---------|
| `supporter.created` | One-time payment |
| `membership.started` | Recurring subscription started |
| `membership.updated` | Recurring subscription renewed/changed |

### Cabin → Subscription tier

| Cabin | Tier |
|-------|------|
| Economy | `free` |
| Business | `plus` |
| First | `pro` |

### Response actions

| `action` | Meaning |
|----------|---------|
| `payment_confirmed` | Cabin set; user + subscription + seat updated |
| `needs_review` | Payment arrived but `PassengerFlight.cabin` was null |
| `sponsored_bypass` | `is_sponsored` user — no writes |
| `no_user_found` | Email not registered in TUJ |
| `no_flight_row` | No unconfirmed `PassengerFlight` row |

### Auth

| Surface | Mechanism |
|---------|-----------|
| Base44 | HMAC-SHA256 via `x-bmac-signature` header (`sha256=<hex>`) |

### Required env — Base44 deploy

```
BMAC_WEBHOOK_SECRET
```

### Deploy checklist

1. Copy `base44-functions/handleBmacWebhook.ts` and `base44-functions/shared/*` into Base44 Dashboard → Code → Functions.
2. Set `BMAC_WEBHOOK_SECRET` in Base44 secrets vault (`base44 secrets set BMAC_WEBHOOK_SECRET=...`).
3. Register the Base44 function URL as the BMAC webhook endpoint.
4. Ensure Cabin Selection UI calls `prepareBmacCabinCheckout` from `gate-contract.js` before BMAC redirect (see `docs/cabin-selection-bmac-contract.md`).

## notifyTaskFailure

| Surface | Path |
|---------|------|
| Base44 (deploy target) | `base44-functions/notifyTaskFailure.ts` |
| Base44 caller helper | `base44-functions/shared/notifyTaskFailureClient.ts` |
| Netlify (shared helper) | `netlify/functions/shared/notify-task-failure.js` |

Internal-only admin alert when drift scan, JD sync, or other scheduled tasks fail.
Requires `SEC06_INTERNAL_TOKEN` via `x-internal-token` or `Authorization: Bearer` on Base44.
Netlify scheduled handlers (`alignment-loop`, `signalwelcome-runner`, `beehiiv-sync`) call the
shared helper directly on uncaught failures.

Required env:

```
SEC06_INTERNAL_TOKEN
TASK_FAILURE_ALERT_EMAIL          # canonical; TASK_FAILURE_EMAIL accepted as alias
```

Base44 scheduled functions should call via `notifyTaskFailureBestEffort` from
`shared/notifyTaskFailureClient.ts` (set `NOTIFY_TASK_FAILURE_URL` to the deployed
function URL). Netlify also needs `SENDGRID_API_KEY` and `SENDGRID_FROM_EMAIL` for
the shared helper.
