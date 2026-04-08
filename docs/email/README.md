# SendGrid Email Templates — Canonical Source

**SendGrid is runtime. This directory is the rollback source of truth.**

For the live registry (template IDs, version IDs, active versions, send context), see the
[SendGrid Template Registry](https://www.notion.so/33bbc9d7494c8156abf4dd1a45d50a76) in Notion.

---

## Canonical Footer URLs (all templates)

| Link Label | URL |
|---|---|
| Request a Seat | `https://www.thispagedoesnotexist12345.com/request-seat` |
| View Master Requirements | `https://www.thispagedoesnotexist12345.tech/mission-control/requirements` |
| Reject & Return | `https://www.thispagedoesnotexist12345.tech/reject-return` |
| Unsubscribe | `{{unsubscribe_url}}` |

---

## Template Token Sets

### boarding_pass_paid_v1
`d-9290e951724f4b028d94945d4f06b69f` · active: `v1-dark-neon`
Tokens: `first_name`, `last_name`, `seat_id`, `passport_url`, `signup_date`, `unsubscribe_url`

### boarding_pass_free_v1
`d-91ca65ce16634f299a46af4f0645d540` · active: `v7-dark-neon-canonical-2026-04-07`
Tokens: `first_name`, `seat_id`, `passport_url`, `unsubscribe_url`

### boarding_instructions_paid_v1
`d-d8ec12e940944c5596af1fa740cf7f07` · active: `v7-dark-neon-canonical-2026-04-07` · v5 inactive
Tokens: `first_name`, `flight_code`, `first_task_url`, `seat_id`, `secondary_url`, `unsubscribe_url`

### boarding_instructions_free_v1
`d-747dac53dd2c4b47b33400376aad1672` · active: `v1-dark-neon`
Tokens: `first_name`, `seat_id`, `unsubscribe_url`

### internalsignupnotification_v1
Internal only — no unsubscribe token required
Tokens: `first_name`, `last_name`, `email`, `seat_id`, `signup_date`

### alphaflightannouncement_v1
`d-79b354192f4740e0a9c6a90ceea61bd2` · active: `v1-dark-neon`
Tokens: `first_name`, `seats_available`, `unsubscribe_url`

### beta_flight_announcement_v1
`d-06e48223cbd0480791430ed3121df93e` · active: `v1-dark-neon`
Tokens: `first_name`, `seats_available`, `unsubscribe_url`

### vipflightannouncement_v1
`d-6d43846cde8f4dea979b5a184394c76c` · active: `v1-dark-neon`
Tokens: `first_name`, `flight_code`, `departure_date`, `seats_available`, `unsubscribe_url`

### qa_wolf_announcement_v1
`d-1b03cb2339634b528b060f41a41221e2` · active: `v1-dark-neon`
Flight: Corporate Games Flight 0 · FL 0000 · Apr 27, 2026 · Internal QA only
Tokens: `first_name`, `flight_code`, `departure_date`, `unsubscribe_url`

### solo_flight_announcement_v1
`d-9741978743224d65a10a89c83b79db98` · active: `v1-dark-neon`
Flight: Solo Flight 1 · FL 0101 · May 5, 2026 · Staged
Tokens: `first_name`, `flight_code`, `departure_date`, `seats_available`, `seat_id`, `unsubscribe_url`

---

## Gold Originals Archive

Pre-dark-neon gold/legacy versions are preserved at:
`sendgrid-templates/archive/gold-originals/`
Commit: `f876e25` — use as rollback reference when March campaigns resume.

---

## Notes

- `founding_fare_unlocked_v1` — no active version in SendGrid as of Apr 7, 2026. Paste HTML and activate when ready.
- `boarding_instructions_paid_v1` — Notion master registry table needs manual update: active version = `v7-dark-neon-canonical-2026-04-07`, token set = `first_name, flight_code, first_task_url, seat_id, secondary_url, unsubscribe_url`.
- All announcement templates: banner stripped before live sends. Test sends pending daily quota reset.
