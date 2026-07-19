# SendGrid Templates — Gold Originals Archive

**Archived:** Apr 7, 2026
**Purpose:** Preserve the original gold/legacy-gold theme templates before the dark neon v1 re-skin.

These are the exact files that were live in SendGrid at the time of the first test send (Apr 7, 2026). They are the source of truth for the "March season" gold aesthetic and should be restored if the seasonal theme is needed again.

## Files

| Archive filename | SendGrid template | Accent color | Theme |
|---|---|---|---|
| `boarding_pass_free_v0-legacy-gold.html` | `boarding_pass_free_v1` (d-91ca65ce16634f299a46af4f0645d540) | `#A8C400` (lime-gold) | Gold |
| `boarding_pass_paid_v0-legacy-gold.html` | `boarding_pass_paid_v1` (d-9290e951724f4b028d94945d4f06b69f) | `#FFD700` (gold) | Gold |
| `boarding_instructions_free_v0-legacy-gold.html` | `boarding_instructions_free_v1` (d-747dac53dd2c4b47b33400376aad1672) | `#A8C400` (lime-gold) | Gold |
| `boarding_instructions_paid_v0-legacy-gold.html` | `boarding_instructions_paid_v1` (d-d8ec12e940944c5596af1fa740cf7f07) | `#A8C400` (lime-gold) | Gold |
| `internalsignupnotification_v0-legacy-gold.html` | `internalsignupnotification_v1` (internal only) | `#A8C400` (lime-gold) | Gold |

## Notes

- All files use `{{unsubscribe_url}}` (not `{{unsubscribe}}`).
- All files use `Forward Airways` branding (not `PageForward Airways`).
- The `boarding_pass_free_v1` gold version was the template that fired on the Apr 7, 2026 test send — confirming the dark neon v1 was never set active in SendGrid.
- The two templates not in this archive (`alphaflightannouncement_v1`, `exec_preboard_opentowork_v1`) were not in the repo at archive time; their gold originals live in SendGrid only.
- **Do not edit these files.** They are read-only reference copies.
