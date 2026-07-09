/** Shared env helpers for Base44 Deno functions (reference copy for deploy parity). */

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return String(value).trim();
}

export function firstRequiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value && String(value).trim()) {
      return String(value).trim();
    }
  }
  throw new Error(`Missing required env (tried: ${names.join(', ')})`);
}

export function optionalEnv(name: string): string {
  const value = Deno.env.get(name);
  return value && String(value).trim() ? String(value).trim() : '';
}

export function firstOptionalEnv(...names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

export function requiredIntEnv(name: string): number {
  const raw = requiredEnv(name);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Env ${name} must be an integer`);
  }
  return parsed;
}

export function requiredUrlEnv(name: string): string {
  const value = requiredEnv(name);
  try {
    new URL(value);
  } catch {
    throw new Error(`Env ${name} must be a valid URL`);
  }
  return value.replace(/\/$/, '');
}
