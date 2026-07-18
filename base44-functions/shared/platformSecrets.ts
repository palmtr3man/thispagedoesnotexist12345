/**
 * Canonical platform-managed secret names for Base44 backend functions.
 *
 * Values must be stored in the Base44 secrets vault (`base44 secrets set`), not hardcoded.
 */

/** Names approved for backend function env access (platform-managed secrets). */
export const PLATFORM_MANAGED_SECRET_NAMES = new Set([
  'ACTIVE_FLIGHT_CODE',
  'ACTIVE_FLIGHT_ID',
  'ALLOWED_ORIGINS',
  'APP_BASE_URL',
  'BMAC_ALPHA_PRODUCT_ID',
  'BMAC_API_KEY',
  'BMAC_BETA_PRODUCT_ID',
  'BMAC_WEBHOOK_SECRET',
  'DEMO_SEAT_ID',
  'DEMO_SEAT_IDS',
  'EMAIL_PROVIDER',
  'GOOGLE_CALENDAR_EVENTS_URL',
  'GATE1_REPAIR_TARGET_EMAIL',
  'GATE1_REPAIR_TUJ_CODE',
  'INVITE_TEMPLATE_ID',
  'MIGRATE_SEAT_IDS_MAP',
  'MIGRATION_SEAT_IDS',
  'MIGRATION_SEAT_IDS_MAP',
  'NOTION_PIPELINE_DATABASE_ID',
  'NOTION_SEAT_DB_ID',
  'NOTION_PASSENGER_PIPELINE_DB_ID',
  'PILOT_SEAT_ID',
  'PILOT_USER_TUJ_CODE',
  'PLATFORM_URL',
  'SENDGRID_API_KEY',
  'SENDGRID_FROM_EMAIL',
  'SENDGRID_TEMPLATE_INTAKE',
  'SENDGRID_UNSUBSCRIBE_GROUP_TRANSACTIONAL',
  'SEC06_INTERNAL_TOKEN',
  'SUPPORT_EMAIL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_URL',
  'TASK_FAILURE_ALERT_EMAIL',
  'TASK_FAILURE_EMAIL',
]);

/** Preferred name first; later names are backward-compatible aliases. */
export const ENV_ALIASES = {
  activeFlightCode: ['ACTIVE_FLIGHT_CODE', 'ACTIVE_FLIGHT_ID'],
  activeFlightId: ['ACTIVE_FLIGHT_ID', 'ACTIVE_FLIGHT_CODE'],
  inviteTemplateId: ['SENDGRID_TEMPLATE_INTAKE', 'INVITE_TEMPLATE_ID'],
  migrationSeatIdsMap: ['MIGRATION_SEAT_IDS_MAP', 'MIGRATION_SEAT_IDS', 'MIGRATE_SEAT_IDS_MAP'],
  taskFailureAlertEmail: ['TASK_FAILURE_ALERT_EMAIL', 'TASK_FAILURE_EMAIL'],
  notionPassengerPipelineDbId: [
    'NOTION_SEAT_DB_ID',
    'NOTION_PASSENGER_PIPELINE_DB_ID',
    'NOTION_PIPELINE_DATABASE_ID',
  ],
  pilotSeatId: ['DEMO_SEAT_ID', 'PILOT_USER_TUJ_CODE', 'PILOT_SEAT_ID'],
} as const;
