# Vector 2 Phase 1 Entrypoint Split

## Route contract

- `thispagedoesnotexist12345.com/` -> `/index.html` (Public / Marketing)
- `thispagedoesnotexist12345.com/Studio` and descendants -> `/Studio/index.html` or the requested Studio asset
- `thispagedoesnotexist12345.tech/` -> `/CommandCenter/index.html` (App / Ops / Dashboard)
- `.tech/Dashboard`, `.tech/Ops`, `.tech/JDLibrary`, and `.tech/MissionControl` -> `/CommandCenter/index.html`
- `.tech/Passengers`, `.tech/FlightLog`, `.tech/Applications`, and `.tech/InterviewsAndFollowUps` -> `/CommandCenter/index.html`
- `/api/*` and `/.netlify/functions/*` remain available; API rewrites are evaluated before the fallback.
- Unknown hosts and local development fall back to `/index.html`.
- Any `.tech` path not explicitly listed above falls through to the generic SPA redirect and resolves to the public `/index.html` shell, not to `/CommandCenter/index.html`. The `.tech` routing in this phase is an allow-list of known operational paths, not full host isolation: only the apex (`/`) is force-redirected to CommandCenter, so any current or future `.tech` path outside the allow-list is served the public bundle until it is explicitly added here and to `netlify.toml`.

This is a Phase 1 routing isolation layer. Dedicated App/Ops/Dashboard shells can replace the CommandCenter target in a later phase without changing the hostname contract.

## CI / workflow authentication

Two GitHub Actions workflows gate on repository secrets and authenticate to Infisical using Universal Auth (`INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET`) rather than OIDC:

- `.github/workflows/drift-check.yml` — the credential-availability gate is retained (the job still checks for `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `NETLIFY_AUTH_TOKEN`, and `NETLIFY_SITE_ID` before running), but the Infisical login step now authenticates with Universal Auth via `infisical login --method=universal-auth --client-id=... --client-secret=...` instead of the previous OIDC-based `Infisical/auth-action`.
- `.github/workflows/sec05-vault-sync.yml` — switched from the OIDC `Infisical/auth-action` to the same Universal Auth login flow, and the job's `id-token: write` permission was removed since OIDC token issuance is no longer needed; the job permissions are now limited to `contents: read`.

Both workflows remain red (failing their credential gate or Infisical login step) until the `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` repository secrets are provisioned in GitHub Actions. This is expected and does not indicate a regression in the entrypoint-split change itself.

## Validation note

The configuration was reviewed against the verified root entrypoints (`index.html`, `Studio/index.html`, and `CommandCenter/index.html`). Netlify build execution and browser-level host testing must run in CI or a Netlify deploy preview because this MCP session has no local checkout of the target repository.
