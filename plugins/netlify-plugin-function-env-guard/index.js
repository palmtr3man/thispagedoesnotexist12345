const BYTE_LIMIT = 4096;
const TARGET_MAX_BYTES = 3800;

const FUNCTION_ENV_NAMES = new Set([
  'ACTIVE_FLIGHT_CODE',
  'ACTIVE_FLIGHT_DEPARTURE_DATE',
  'ACTIVE_FLIGHT_ID',
  'ACTIVE_FLIGHT_LABEL',
  'ADMIN_ORIGIN',
  'AGE_TOKEN_SECRET',
  'ALIGNMENT_CRON_SECRET',
  'ALPHA_MODE',
  'BASE44_APPLICATION_URL',
  'BASE44_COHORT_STATUS_URL',
  'BASE44_SEAT_LIST_URL',
  'BASE44_SEAT_REQUEST_URL',
  'BASE44_SEAT_URL',
  'BASE44_SET_DEPARTURE_URL',
  'BASE44_USER_URL',
  'BASE44APIKEY',
  'BASE44SEATREQUEST_URL',
  'BASE44_API_KEY',
  'BEEHIIV_API_KEY',
  'BEEHIIV_GIFT_LINK_URL',
  'BEEHIIV_PUB_ID',
  'BEEHIIV_SYNC_LIVE_ENABLED',
  'BOARDING_CONFIRMATION_DISPATCH_LEASE_MS',
  'BOARDING_DRY_RUN',
  'DEMO_ACCOUNT_EMAIL',
  'DEMO_FIRST_NAME',
  'DEMO_FLIGHT_CODE',
  'DEMO_LAST_NAME',
  'DEMO_SEAT_ID',
  'DEMO_SEAT_IDS',
  'DEMO_SEND_SECRET',
  'NETLIFY_API_KEY',
  'NETLIFY_SITE_ID',
  'NOTION_API_KEY',
  'NOTION_DRIFT_REPORT_DB_ID',
  'NOTION_JD_PIPELINE_DB_ID',
  'NOTION_SEAT_DB_ID',
  'NOTION_SEAT_REQUEST_DATABASE_ID',
  'NOTION_SECRET',
  'PASSPORT_URL',
  'PASSENGER_AUTH_TOKEN',
  'PASSENGER_READY_TOKEN',
  'PILOT_TOKEN',
  'PLATFORM_URL',
  'PUBLIC_GATE_STATE',
  'READY_CLICK_IDEMPOTENCY_GUARD_OPTIONAL',
  'READY_CLICK_IDEMPOTENCY_TABLE',
  'READY_CLICK_OPEN_ASSIGNMENT_ENABLED',
  'READY_CLICK_PASSENGER_TOKEN',
  'READY_CLICK_SEND_ENABLED',
  'SEC06_INTERNAL_TOKEN',
  'SEC06_SCHEDULER_SECRET',
  'SENDER_EMAIL',
  'SENDGRID_API_KEY',
  'SENDGRID_DEBUG',
  'SENDGRID_DEMO_DAILY_LIMIT',
  'SENDGRID_FROM_EMAIL',
  'SENDGRID_FROM_NAME',
  'SENDGRID_STRICT_TEMPLATE_CHECK',
  'SENDGRID_TEMPLATE_ALPHA_ANNOUNCEMENT',
  'SENDGRID_TEMPLATE_ALPHA_FLIGHT_ANNOUNCEMENT',
  'SENDGRID_TEMPLATE_ALPHA_SEAT_CONFIRM',
  'SENDGRID_TEMPLATE_BOARDING_CONFIRMATION',
  'SENDGRID_TEMPLATE_BOARDING_INSTRUCTIONS_FREE',
  'SENDGRID_TEMPLATE_BOARDING_INSTRUCTIONS_PAID',
  'SENDGRID_TEMPLATE_BOARDING_PASS_FREE',
  'SENDGRID_TEMPLATE_BOARDING_PASS_PAID',
  'SENDGRID_TEMPLATE_EXEC_PREBOARD',
  'SENDGRID_TEMPLATE_INTERNAL_SIGNUP',
  'SENDGRID_TEMPLATE_NEXT_FLIGHT_WAITLIST',
  'SENDGRID_TEMPLATE_OFFER_CONGRATS',
  'SENDGRID_TEMPLATE_OPT_OUT_ACK',
  'SENDGRID_TEMPLATE_PREBOARD_NURTURE',
  'SENDGRID_TEMPLATE_SEAT_REQUEST',
  'SENDGRID_TEMPLATE_SPONSORED_APPROVED',
  'SENDGRID_TEMPLATE_VIP_BOARDING_INSTRUCTIONS',
  'SENDGRID_TEMPLATE_VIP_BOARDING_PASS',
  'SENDGRID_TEMPLATE_WELCOME',
  'SENDGRID_UNSUBSCRIBE_GROUP_MARKETING',
  'SENDGRID_UNSUBSCRIBE_GROUP_TRANSACTIONAL',
  'SENDGRID_UNSUBSCRIBE_URL',
  'SIGNALWELCOME_CANDIDATE_TAG',
  'SIGNALWELCOME_SENT_TAG',
  'SIGNAL_URL',
  'SITE_URL',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_URL',
  'TASK_FAILURE_ALERT_EMAIL',
  'TASK_FAILURE_EMAIL',
]);

const PLATFORM_PREFIXES = [
  'AWS_',
  'BRANCH',
  'BUILD_',
  'COMMIT_',
  'CONTEXT',
  'DEPLOY_',
  'NETLIFY',
  'NODE_',
  'NPM_',
  'PATH',
  'PWD',
  'REPOSITORY_',
  'SITE_',
  'URL',
];

const BUILD_ONLY_ENV_NAMES = new Set([
  'SECRETS_SCAN_OMIT_KEYS',
  'SECRETS_SCAN_OMIT_PATHS',
]);

function envByteSize(entries) {
  return entries.reduce((total, [key, value]) => total + Buffer.byteLength(`${key}=${value || ''}`), 0);
}

function isPlatformEnv(name) {
  return PLATFORM_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix));
}

function shouldExcludeFromFunctionPayload(name) {
  return BUILD_ONLY_ENV_NAMES.has(name) || isPlatformEnv(name);
}

function shouldDeleteFromEnvironment(name) {
  if (BUILD_ONLY_ENV_NAMES.has(name)) return true;
  if (isPlatformEnv(name)) return false;
  return !FUNCTION_ENV_NAMES.has(name);
}

function canTrim(name) {
  if (FUNCTION_ENV_NAMES.has(name)) return false;
  if (shouldExcludeFromFunctionPayload(name)) return false;
  return true;
}

module.exports = {
  onPostBuild({ utils }) {
    const entries = Object.entries(process.env);
    for (const [name] of entries) {
      if (shouldDeleteFromEnvironment(name)) {
        delete process.env[name];
      }
    }

    const functionEntries = entries.filter(([name]) => !shouldExcludeFromFunctionPayload(name));
    const initialSize = envByteSize(functionEntries);

    if (initialSize <= TARGET_MAX_BYTES) {
      console.log(`[function-env-guard] Environment payload is ${initialSize} bytes; no trimming needed.`);
      return;
    }

    const candidates = functionEntries
      .filter(([name]) => canTrim(name))
      .map(([name, value]) => ({
        name,
        size: Buffer.byteLength(`${name}=${value || ''}`),
      }))
      .sort((a, b) => b.size - a.size);

    let currentSize = initialSize;
    let trimmedCount = 0;

    for (const candidate of candidates) {
      if (currentSize <= TARGET_MAX_BYTES) break;
      currentSize -= candidate.size;
      delete process.env[candidate.name];
      trimmedCount += 1;
    }

    console.log(
      `[function-env-guard] Trimmed ${trimmedCount} non-function environment variable(s); estimated payload ${currentSize} bytes.`
    );

    if (currentSize > BYTE_LIMIT) {
      utils.build.failBuild(
        `Function environment is still above AWS Lambda's ${BYTE_LIMIT} byte limit after trimming non-function variables. Move large required function values to function-scoped Netlify environment variables or an external secret store.`
      );
    }
  },
};
