# Beehiiv Issue 2 Canon Migration

## Purpose

This document locks the implementation contract for Beehiiv issue 2. The migration introduces `public.beehiiv_sync_log` as the durable audit trail for Beehiiv flight/cohort sync attempts, while the edge-function contract standardizes the identity payload used by future sync logic.

## Canonical Flight Identity

The sync contract separates the **machine identifier** from the **display identifier**. The `flight_key` value is the canonical machine key and must be uppercase, underscore-delimited, and free of spaces. The `flight_id` value is the human-facing display string used in Beehiiv copy and must be uppercase and space-delimited.

| Field | Purpose | Required Format | Example |
|---|---|---|---|
| `flight_key` | Machine identifier used for database lookups, logs, idempotency, and internal joins. | `^[A-Z0-9_]+$` | `FL_051126` |
| `flight_id` | Display identifier used in Beehiiv copy and template variables. | `^[A-Z0-9 ]+$` | `FL 051126` |
| `cohort_id` | Cohort identifier used to select the audience to sync. | Non-empty string. | `gemini-alpha-2026-05-11` |
| `dry_run` | Safety switch. Defaults to `true`; live writes require explicit `false`. | Boolean. | `true` |

The normalization rule is deterministic: `flight_key` must equal `upper(trim(flight_id))` after whitespace is collapsed to underscores. For example, `FL 051126` normalizes to `FL_051126`. The SQL migration enforces this pairing through a check constraint so a drifted payload cannot create an audit row.

## Edge-Function Input Shape

The future Beehiiv sync endpoint should accept a JSON body with the following shape. The handler should reject any request that does not include a valid identity pair.

```json
{
  "flight_key": "FL_051126",
  "flight_id": "FL 051126",
  "cohort_id": "gemini-alpha-2026-05-11",
  "dry_run": true,
  "segment_key": "gemini-alpha",
  "boarding_opened_at": "2026-05-11T12:34:00Z",
  "boarding_closed_at": null
}
```

## Validation Rules

The edge function should trim all string inputs, uppercase `flight_key` and `flight_id`, collapse repeated whitespace in `flight_id`, derive the expected key with `flight_id.replace(/\s+/g, '_')`, and reject the request if the provided `flight_key` does not match that derived key. The handler should default `dry_run` to `true` when omitted.

| Validation | Expected Behavior |
|---|---|
| Missing `flight_key`, `flight_id`, or `cohort_id` | Return `400` with a structured validation error. |
| `flight_key` contains spaces or lowercase letters | Normalize only if safe, then validate; reject if the final value does not match `^[A-Z0-9_]+$`. |
| `flight_id` contains underscores | Reject. The display identifier must use spaces. |
| Derived key does not match supplied `flight_key` | Return `400` and do not write a live sync result. |
| `dry_run` omitted | Treat as `true`. |

## Audit Log Lifecycle

Each invocation should insert one `beehiiv_sync_log` row at the beginning of processing with `status = 'started'`. The function should update that row to `completed`, `failed`, or `skipped` before returning. Terminal statuses require `completed_at` by constraint.

| Column | Meaning |
|---|---|
| `matched` | Cohort members found for the requested flight/cohort. |
| `updated` | Beehiiv subscriber records patched or queued successfully. |
| `failed` | Subscriber updates that failed. |
| `skipped` | Records skipped because they were out of cohort, already current, or invalid for sync. |
| `metadata` | Non-secret diagnostic metadata and response summaries. Never store API keys or raw secret material. |

## Deployment Notes

The migration file is `supabase/migrations/20260511_beehiiv_issue_2_canon.sql`. It is intentionally service-role-only under RLS, matching existing operational tables in this repository. Before a live Beehiiv sync is enabled, the runtime environment should define the Beehiiv API credentials and the sync endpoint should enforce an internal bearer token or webhook secret.

## Runtime Endpoint

Dry-run sync is exposed at `POST /api/beehiiv-sync` (Netlify function `netlify/functions/beehiiv-sync.js`).

| Requirement | Value |
|---|---|
| Auth | `x-admin-secret: $ADMIN_SECRET` |
| Default mode | `dry_run: true` when omitted |
| Live writes | Require `dry_run: false` **and** `BEEHIIV_SYNC_LIVE_ENABLED=true` |

Live mode PATCHes Beehiiv custom fields: `flight_id`, `flight_key`, `cohort_id`, `flight_tag`, and optional `segment_key`. Subscribers already carrying the target values are counted as skipped.

### Base44 field mapping

| Sync contract | Base44 / Supabase source |
|---|---|
| `flight_key` | `Flight.flight_code` / `seat_requests.flight_id` |
| `flight_id` | `NextFlightConfig.next_flight_number` (display flight number, e.g. `FL 051126`) |
| `cohort_id` | Logical cohort slug; falls back to `cohorts.flight_id = flight_key` when no UUID match |
