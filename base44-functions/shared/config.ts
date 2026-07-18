/**
 * Shared runtime configuration helpers for Base44 edge functions.
 *
 * SEC-04 policy: configuration required for production behavior must come from
 * environment variables and must fail closed when missing. Do not add literal
 * production URL, email, template, database, or Netlify site fallbacks here.
 */

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new Error(`[config] Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = Deno.env.get(name)?.trim();
  return value || undefined;
}

export function requiredUrlEnv(name: string): string {
  return requiredEnv(name).replace(/\/$/, '');
}

export function requiredIntEnv(name: string): number {
  const raw = requiredEnv(name);
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`[config] Environment variable ${name} must be an integer`);
  }
  return value;
}

export function requiredCsvEnv(name: string): string[] {
  const values = requiredEnv(name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) {
    throw new Error(`[config] Environment variable ${name} must contain at least one value`);
  }

  return values;
}

/** Google Calendar primary events collection URL (no trailing slash). */
export function googleCalendarPrimaryEventsUrl(): string {
  return requiredUrlEnv('GOOGLE_CALENDAR_EVENTS_URL');
}
