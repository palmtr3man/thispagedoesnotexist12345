/**
 * Canonical parity manifest for Infisical ↔ Netlify drift checks.
 * Keep aligned with career-navigator/scripts/sync-infisical-vault.ts PARITY_KEYS.
 */

/** P0 — hard fail when missing on Netlify (staging/prod). */
export const P0_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SEC06_INTERNAL_TOKEN',
  'SENDGRID_API_KEY',
] as const;

/** P1 — parity / namespace keys; hard fail on main/develop/PR. */
export const P1_KEYS = [
  'BASE44_AUTH_JSON',
  'BASE44_APP_ID',
  'BEEHIIV_API_KEY',
  'NOTION_API_KEY',
  'NOTION_SECRET',
  'NOTION_SEAT_DB_ID',
  'NOTION_DRIFT_REPORT_DB_ID',
  'NOTION_JD_PIPELINE_DB_ID',
  'SEC06_SCHEDULER_SECRET',
  'BASE44_SEAT_URL',
  'BASE44_USER_URL',
  'BASE44_APPLICATION_URL',
  'ACTIVE_FLIGHT_CODE',
  'SENDGRID_TEMPLATE_SEAT_REQUEST',
] as const;

/** At least one key in each group must be present on Netlify. */
export const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['BASE44_API_KEY', 'BASE44APIKEY'],
  ['ACTIVE_FLIGHT_ID', 'ACTIVE_FLIGHT_CODE'],
  ['NOTION_API_KEY', 'NOTION_SECRET'],
  ['NOTION_SEAT_DB_ID', 'NOTION_CANON_PROFILE_DB_ID'],
  ['SEC06_INTERNAL_TOKEN', 'ALIGNMENT_WEBHOOK_SECRET'],
  ['SEC06_SCHEDULER_SECRET', 'ALIGNMENT_CRON_SECRET'],
  ['SUPABASE_URL', 'APP_URL', 'APP_BASE_URL'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'APP_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY'],
  ['TASK_FAILURE_ALERT_EMAIL', 'TASK_FAILURE_EMAIL'],
];

export const ALL_MANIFEST_KEYS = [...new Set([...P0_KEYS, ...P1_KEYS])];
