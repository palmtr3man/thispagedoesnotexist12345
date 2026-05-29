# Netlify Demo Environment Setup Status

The Netlify environment for the `TUJ-KC2222` demo Seat ID has been configured on the `thispagedoesnotexist12345` project. The demo variables were imported and verified in the Netlify Environment variables page under the `DEMO_` filter.

## Configured environment variables

| Variable | Configuration status | Notes |
|---|---|---|
| `DEMO_ACCOUNT_EMAIL` | Present | Demo recipient is `k.clark7@gmail.com`. |
| `DEMO_FIRST_NAME` | Present | Demo personalization token is `Kevin`. |
| `DEMO_LAST_NAME` | Present | Demo personalization token is `Clark`. |
| `DEMO_FLIGHT_CODE` | Present | Demo flight code is `FL_051126`. |
| `DEMO_SEAT_ID` | Present | Demo Seat ID is `TUJ-KC2222`. |
| `DEMO_SEAT_IDS` | Present | Demo Seat allowlist includes `TUJ-KC2222`. |
| `DEMO_SEND_SECRET` | Present | Generated private secret; do not expose. |
| `SENDGRID_DEMO_DAILY_LIMIT` | Present | Configured as `100`. |

The imported variables are scoped to **Builds, Functions, Runtime** and are available in the selected deploy contexts: **Production, Deploy Previews, Branch deploys, Preview Server & Agent Runners, and Local development**.

## Deploy verification

A fresh deploy preview was triggered after configuration. The first deploy failed because all demo values had been imported as secrets, and Netlify’s secrets scanner correctly found non-sensitive demo values such as `TUJ-KC2222`, `Kevin`, and `FL_051126` in repository files or deploy output. I corrected this by updating `SECRETS_SCAN_OMIT_KEYS` for the non-sensitive demo keys while leaving `DEMO_SEND_SECRET` protected.

The corrected deploy preview succeeded:

| Item | Result |
|---|---|
| Pull request | https://github.com/palmtr3man/thispagedoesnotexist12345/pull/27 |
| Deploy preview | https://deploy-preview-27--thispagedoesnotexist12345.comlify.app/ |
| Latest deploy | Successful; functions bundled and deployed. |
| Secrets scan | Passed; no secrets detected in build output or repository code. |
| Function count | 14 functions deployed, including `demo-sendgrid.js`. |

## Endpoint verification

The demo Seat ID endpoint was tested successfully on the deploy preview:

```json
{"valid":true,"seat_id":"TUJ-KC2222","status":"opened","demo":true,"source":"DEMO_SEAT_IDS"}
```

The secured SendGrid fan-out endpoint was also tested without a secret header and correctly rejected the request with HTTP `401 Unauthorized`, confirming the endpoint is deployed and protected without sending emails.

## Production note

The Netlify environment is configured now, but the new demo endpoint and allowlist code are still in pull request #27. Merge the PR to make the `TUJ-KC2222` demo flow available on the production domain. Until then, it is available on the deploy preview.
