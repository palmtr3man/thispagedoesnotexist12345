# TUJ-KC2222 Demo Seat and SendGrid Fan-Out Handoff

The implementation has been prepared in pull request [#27](https://github.com/palmtr3man/thispagedoesnotexist12345/pull/27), titled **Enable TUJ-KC2222 demo seat and SendGrid fan-out**. The branch is `fix/demo-seat-sendgrid` against `main`.

## What changed

| Area | Change | Result |
|---|---|---|
| Mission Control access | `/api/seat` now includes a small demo allowlist through `DEMO_SEAT_IDS`, defaulting to `TUJ-KC2222`. | `TUJ-KC2222` can validate as an opened demo seat even when the Base44 Seat record is missing or unavailable. |
| SendGrid demo email testing | Added secured endpoint `/api/demo-sendgrid`. | An admin can fan out the configured SendGrid templates to the demo recipient stored in `DEMO_ACCOUNT_EMAIL`. |
| Safety controls | The demo sender requires `x-demo-secret` or `x-admin-secret` and enforces `SENDGRID_DEMO_DAILY_LIMIT`, defaulting to 100. | The endpoint cannot be used publicly and has a documented send cap. |
| Mission Control activation panel | Fixed the session key mismatch from `tuj_seat_id` to the actual `seat_id` key, while retaining backward compatibility. The response parser was also corrected. | The pilot/demo activation panel can recognize `TUJ-KC2222` and show real activation errors instead of silently failing. |
| Environment documentation | `.env.example` now documents `DEMO_SEAT_IDS`, `DEMO_ACCOUNT_EMAIL`, `DEMO_SEND_SECRET`, and related demo variables. | Netlify setup is explicit and reproducible. |

## Required Netlify environment variables

| Variable | Recommended value | Purpose |
|---|---|---|
| `DEMO_SEAT_IDS` | `TUJ-KC2222` | Allows the demo Seat ID through `/api/seat`. |
| `DEMO_SEAT_ID` | `TUJ-KC2222` | Default Seat ID used by `/api/demo-sendgrid`. |
| `DEMO_ACCOUNT_EMAIL` | Your receiving email address | The recipient that receives demo boarding passes and template emails. |
| `DEMO_FIRST_NAME` | `Kevin` | Demo personalization token. |
| `DEMO_LAST_NAME` | `Clark` | Demo personalization token. |
| `DEMO_FLIGHT_CODE` | `FL_051126` | Demo flight code used in email templates. |
| `DEMO_SEND_SECRET` | Generate a random secret | Optional dedicated secret for `/api/demo-sendgrid`; otherwise it falls back to `ADMIN_SECRET`. |
| `SENDGRID_DEMO_DAILY_LIMIT` | `100` | Maximum number of templates allowed per demo fan-out request. |

## How to use after merge and deploy

After the pull request is merged and Netlify finishes deploying, `TUJ-KC2222` should open Mission Control through the normal Seat ID flow. To send demo emails, make a secured `POST` request to `/api/demo-sendgrid` with either the `x-demo-secret` or `x-admin-secret` header.

Example request:

```bash
curl -X POST "https://www.thispagedoesnotexist12345.com/api/demo-sendgrid" \
  -H "Content-Type: application/json" \
  -H "x-demo-secret: $DEMO_SEND_SECRET" \
  -d '{"seat_id":"TUJ-KC2222"}'
```

To send only a subset of templates, pass a `templates` array:

```bash
curl -X POST "https://www.thispagedoesnotexist12345.com/api/demo-sendgrid" \
  -H "Content-Type: application/json" \
  -H "x-demo-secret: $DEMO_SEND_SECRET" \
  -d '{"seat_id":"TUJ-KC2222","templates":["seat_request_acknowledgement_v1","boarding_pass_paid_v1","boarding_instructions_paid_v1"]}'
```

## Validation completed

The modified JavaScript files passed syntax checks with Node:

```bash
node --check netlify/functions/seat.js
node --check netlify/functions/demo-sendgrid.js
node --check netlify/functions/seat-activate.js
```

The pull request also has a Netlify deploy preview ready, with redirect and header checks passing. One review/check item was still pending at the time of handoff.

## Notes on the original acknowledgement failure

The specific user-visible error, **“Failed to send acknowledgement email,”** is returned by `/api/seat-request` when SendGrid rejects the `seat_request_acknowledgement_v1` send. The code path can fail because of a missing or invalid `SENDGRID_API_KEY`, an unauthenticated or mismatched `SENDGRID_FROM_EMAIL`, an invalid template ID, or a SendGrid API rejection. The new demo endpoint does not hide those failures; it returns per-template status so the failed template and SendGrid response can be identified directly.
