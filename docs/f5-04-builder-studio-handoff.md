# F5-04 — Builder → Studio handoff

The canonical Mission Control gateway lives in this repository at `Studio/index.html`, served at `/Studio`.

Career Navigator (`.tech` SPA) keeps a compatibility shim at `/Builder` that immediately redirects to the canonical gateway with query parameters preserved and normalized.

## Contract

| Param (canonical) | Legacy aliases accepted by redirect shim |
|-------------------|------------------------------------------|
| `resume_id`       | `resumeId`                               |
| `seat_id`         | `seatid`                                 |
| `tuj_code`        | `tujcode`                                |

Other params (`job_id`, `flight_code`, etc.) pass through unchanged.

## Surfaces

| Surface | Behavior |
|---------|----------|
| `career-navigator` `/Builder` | React redirect shim (`src/pages/Builder.jsx`) |
| `career-navigator` onboarding exit | Direct link to canonical Studio URL (`OnboardingPassport.jsx`) |
| `.com` `/Builder` | Netlify 301 → `/Studio` (query preserved) |
| `.com` `/Studio` | Serves `Studio/index.html` |

## Environment

| Repo | Variable | Purpose |
|------|----------|---------|
| career-navigator | `VITE_TUJ_STUDIO_URL` | Override Studio base URL for staging/local (defaults to prod `.com/Studio`) |
| this repo | `STUDIO_GATEWAY_URL` | Documented reference only; gateway is static at `/Studio` |

## Studio initialization

On load, `Studio/index.html` reads:

- `seat_id` — boarding panel + CTA wiring
- `tuj_code` — passthrough to Mission Control CTAs
- `resume_id` (or legacy `resumeId`) — loads resume from Base44 via Career Navigator API

## Related seats

F5-04 is referenced in boarding payloads as `seats_reserved: 'F5-04'` in `gate-contract.js` and SendGrid integration templates.
