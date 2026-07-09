/** SEC-06 internal invocation guard for Base44 Deno functions. */

const INTERNAL_TOKEN_ENV = 'SEC06_INTERNAL_TOKEN';

function submittedInternalToken(req: Request): string {
  const header = req.headers.get('x-internal-token')?.trim();
  if (header) return header;

  const auth = req.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (!left.length || left.length !== right.length) return false;

  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left[i] ^ right[i];
  }
  return mismatch === 0;
}

/** Reject browser-origin requests (CORS preflight / direct fetch from UI). */
export function rejectBrowserOrigin(req: Request): { ok: true } | { ok: false; response: Response } {
  const origin = req.headers.get('origin')?.trim();
  if (origin) {
    return { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ok: true };
}

export function requireInternalToken(req: Request): { ok: true } | { ok: false; response: Response } {
  const originGuard = rejectBrowserOrigin(req);
  if (!originGuard.ok) return originGuard;

  const expected = Deno.env.get(INTERNAL_TOKEN_ENV)?.trim();
  if (!expected) {
    return { ok: false, response: Response.json({ error: 'Server misconfigured' }, { status: 500 }) };
  }

  const supplied = submittedInternalToken(req);
  if (!supplied || !timingSafeEqual(supplied, expected)) {
    return { ok: false, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  return { ok: true };
}

export function auditInvocation(
  functionName: string,
  guard: { ok: true },
  metadata?: Record<string, unknown>,
): void {
  if (!guard.ok) return;
  if (metadata && Object.keys(metadata).length) {
    console.log(`[${functionName}] invocation authorized`, metadata);
    return;
  }
  console.log(`[${functionName}] internal invocation authorized`);
}

type HmacVerifyOptions = {
  secretEnv: string;
  signatureHeader: string;
  prefix?: string;
};

/** Verifies an HMAC-SHA256 webhook signature against the raw request body. */
export async function verifyHmacSha256(
  rawBody: string,
  req: Request,
  options: HmacVerifyOptions,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const secret = Deno.env.get(options.secretEnv)?.trim();
  if (!secret) {
    return { ok: false, response: Response.json({ error: 'Server misconfigured' }, { status: 500 }) };
  }

  const headerValue = req.headers.get(options.signatureHeader)?.trim();
  if (!headerValue) {
    return { ok: false, response: Response.json({ error: 'Missing signature' }, { status: 401 }) };
  }

  const prefix = options.prefix ? `${options.prefix}=` : '';
  const supplied = headerValue.startsWith(prefix) ? headerValue.slice(prefix.length) : headerValue;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(signed))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  if (!timingSafeEqual(supplied.toLowerCase(), expected.toLowerCase())) {
    return { ok: false, response: Response.json({ error: 'Invalid signature' }, { status: 401 }) };
  }

  return { ok: true };
}
