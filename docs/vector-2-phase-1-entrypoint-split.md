# Vector 2 Phase 1 Entrypoint Split

## Route contract

- `thispagedoesnotexist12345.com/` -> `/index.html` (Public / Marketing)
- `thispagedoesnotexist12345.com/Studio` and descendants -> `/Studio/index.html` or the requested Studio asset
- `thispagedoesnotexist12345.tech/` -> `/CommandCenter/index.html` (App / Ops / Dashboard)
- `.tech/Dashboard`, `.tech/Ops`, `.tech/JDLibrary`, and `.tech/MissionControl` -> `/CommandCenter/index.html`
- `/api/*` and `/.netlify/functions/*` remain available; API rewrites are evaluated before the fallback.
- Unknown hosts and local development fall back to `/index.html`.

This is a Phase 1 routing isolation layer. Dedicated App/Ops/Dashboard shells can replace the CommandCenter target in a later phase without changing the hostname contract.

## Validation note

The configuration was reviewed against the verified root entrypoints (`index.html`, `Studio/index.html`, and `CommandCenter/index.html`). Netlify build execution and browser-level host testing must run in CI or a Netlify deploy preview because this MCP session has no local checkout of the target repository.
