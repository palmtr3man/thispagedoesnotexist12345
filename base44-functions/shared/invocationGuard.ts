type GuardSuccess = {
  ok: true;
  requestId: string;
  idempotencyKey?: string;
  actor?: Record<string, unknown> | null;
};

type GuardFailure = {
  ok: false;
  response: Response;
};

export type GuardResult = GuardSuccess | GuardFailure;

type GuardOptions = {
  tokenEnv?: string;
  schedulerSecretEnv?: string;
  requireParentRequestId?: boolean;
  requireIdempotencyKey?: boolean;
};

const DEFAULT_INTERNAL_TOKEN_ENV = 'SEC06_INTERNAL_TOKEN';
const DEFAULT_SCHEDULER_SECRET_ENV = 'SEC06_SCHEDULER_SECRET';

function jsonError(status: number, error: string, detail?: string): Response {
  return Response.json({ error, ...(detail ? { detail } : {}) }, { status });
}

function header(req: Request, name: string): string {
  return req.headers.get(name) || req.headers.get(name.toLowerCase()) || '';
}

function bearerToken(req: Request): string {
  const auth = header(req, 'authorization');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function submittedToken(req: Request): string {
  return header(req, 'x-internal-token').trim() || bearerToken(req);
}

function submittedSchedulerSecret(req: Request): string {
  return header(req, 'x-scheduler-secret').trim() || bearerToken(req);
}

function requiredSecret(envName: string): string | null {
  return Deno.env.get(envName)?.trim() || null;
}

function requestId(req: Request): string {
  return header(req, 'x-request-id').trim() || crypto.randomUUID();
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.length !== bufB.length) return false;

  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

function secretsMatch(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  return timingSafeEqual(supplied, expected);
}

export function rejectBrowserOrigin(req: Request): GuardFailure | null {
  const origin = header(req, 'origin').trim();
  if (!origin) return null;
  return { ok: false, response: jsonError(403, 'insufficient_role', 'Browser-origin requests are not allowed') };
}

export function requireInternalToken(req: Request, options: GuardOptions = {}): GuardResult {
  const originFailure = rejectBrowserOrigin(req);
  if (originFailure) return originFailure;

  const tokenEnv = options.tokenEnv || DEFAULT_INTERNAL_TOKEN_ENV;
  const expected = requiredSecret(tokenEnv);
  if (!expected) return { ok: false, response: jsonError(500, 'server_misconfigured', `${tokenEnv} is required`) };

  const supplied = submittedToken(req);
  if (!supplied) return { ok: false, response: jsonError(401, 'missing_identity', 'Internal token is required') };
  if (!secretsMatch(supplied, expected)) return { ok: false, response: jsonError(403, 'insufficient_role', 'Internal token is invalid') };

  const parentRequestId = header(req, 'x-parent-request-id').trim();
  if (options.requireParentRequestId && !parentRequestId) {
    return { ok: false, response: jsonError(401, 'missing_identity', 'x-parent-request-id is required') };
  }

  const idempotencyKey = header(req, 'x-idempotency-key').trim();
  if (options.requireIdempotencyKey && !idempotencyKey) {
    return { ok: false, response: jsonError(401, 'missing_identity', 'x-idempotency-key is required') };
  }

  return { ok: true, requestId: parentRequestId || requestId(req), idempotencyKey };
}

export function requireHeaderSecret(req: Request, headerName: string, options: GuardOptions = {}): GuardResult {
  const originFailure = rejectBrowserOrigin(req);
  if (originFailure) return originFailure;

  const tokenEnv = options.tokenEnv || DEFAULT_INTERNAL_TOKEN_ENV;
  const expected = requiredSecret(tokenEnv);
  if (!expected) return { ok: false, response: jsonError(500, 'server_misconfigured', `${tokenEnv} is required`) };

  const supplied = header(req, headerName).trim() || submittedToken(req);
  if (!supplied) return { ok: false, response: jsonError(401, 'missing_identity', `${headerName} is required`) };
  if (!secretsMatch(supplied, expected)) return { ok: false, response: jsonError(403, 'insufficient_role', `${headerName} is invalid`) };

  return { ok: true, requestId: requestId(req) };
}

export function requireSchedulerSignature(req: Request, options: GuardOptions = {}): GuardResult {
  const schedulerSecretEnv = options.schedulerSecretEnv || DEFAULT_SCHEDULER_SECRET_ENV;
  const expected = requiredSecret(schedulerSecretEnv);
  if (!expected) return { ok: false, response: jsonError(500, 'server_misconfigured', `${schedulerSecretEnv} is required`) };

  const origin = header(req, 'origin').trim();
  if (origin) return { ok: false, response: jsonError(403, 'insufficient_role', 'Scheduler invocation cannot include a browser Origin') };

  const supplied = submittedSchedulerSecret(req);
  if (!supplied) return { ok: false, response: jsonError(401, 'missing_identity', 'Scheduler signature is required') };
  if (!secretsMatch(supplied, expected)) return { ok: false, response: jsonError(403, 'insufficient_role', 'Scheduler signature is invalid') };

  return { ok: true, requestId: requestId(req) };
}

export async function requireAdminUser(req: Request, base44: any): Promise<GuardResult> {
  let actor: any = null;
  try {
    actor = await base44.auth.me();
  } catch (_) {
    actor = null;
  }

  if (!actor) return { ok: false, response: jsonError(401, 'missing_identity', 'Authenticated admin user is required') };
  if (actor.role !== 'admin') return { ok: false, response: jsonError(403, 'insufficient_role', 'Admin role is required') };

  return { ok: true, requestId: requestId(req), actor };
}

export async function requireSchedulerOrAdmin(req: Request, base44: any, options: GuardOptions = {}): Promise<GuardResult> {
  const schedulerAttempt = requireSchedulerSignature(req, options);
  if (schedulerAttempt.ok) return schedulerAttempt;
  if (schedulerAttempt.response.status === 403 && header(req, 'origin').trim()) return schedulerAttempt;

  return await requireAdminUser(req, base44);
}

/** Server-side internal token or authenticated Base44 session (blocks anonymous service-role reads). */
export async function requireInternalTokenOrAuthenticatedUser(
  req: Request,
  base44: any,
  options: GuardOptions = {},
): Promise<GuardResult> {
  const internalAttempt = requireInternalToken(req, options);
  if (internalAttempt.ok) return internalAttempt;

  const supplied = submittedToken(req);
  if (supplied) return internalAttempt;

  let actor: any = null;
  try {
    actor = await base44.auth.me();
  } catch (_) {
    actor = null;
  }

  if (!actor) {
    return { ok: false, response: jsonError(401, 'missing_identity', 'Authentication or internal token is required') };
  }

  return { ok: true, requestId: requestId(req), actor };
}

function parseAllowedOrigins(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS')?.trim();
  if (!raw) return [];
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

/** Browser-facing public endpoints: trusted Origin header required unless server-to-server. */
export function requireAllowedOrigin(req: Request, options: { allowNoOrigin?: boolean } = {}): GuardResult {
  const origin = header(req, 'origin').trim();
  if (!origin) {
    if (options.allowNoOrigin) return { ok: true, requestId: requestId(req) };
    return { ok: false, response: jsonError(403, 'insufficient_role', 'Origin header is required') };
  }

  const allowedOrigins = parseAllowedOrigins();
  if (!allowedOrigins.length) {
    return { ok: false, response: jsonError(500, 'server_misconfigured', 'ALLOWED_ORIGINS is required') };
  }
  if (!allowedOrigins.includes(origin)) {
    return { ok: false, response: jsonError(403, 'insufficient_role', 'Origin is not allowed') };
  }

  return { ok: true, requestId: requestId(req) };
}

export function requireAllowedOriginOrInternalToken(req: Request, options: GuardOptions = {}): GuardResult {
  const internalAttempt = requireInternalToken(req, options);
  if (internalAttempt.ok) return internalAttempt;

  const supplied = submittedToken(req);
  if (supplied) return internalAttempt;

  return requireAllowedOrigin(req);
}

export async function requireAllowedOriginOrAuthenticatedUser(
  req: Request,
  base44: any,
  options: GuardOptions = {},
): Promise<GuardResult> {
  const originAttempt = requireAllowedOrigin(req);
  if (originAttempt.ok) return originAttempt;

  const internalAttempt = requireInternalToken(req, options);
  if (internalAttempt.ok) return internalAttempt;

  const supplied = submittedToken(req);
  if (supplied) return internalAttempt;

  let actor: any = null;
  try {
    actor = await base44.auth.me();
  } catch (_) {
    actor = null;
  }

  if (!actor) {
    return { ok: false, response: jsonError(401, 'missing_identity', 'Authentication, internal token, or allowed origin is required') };
  }

  return { ok: true, requestId: requestId(req), actor };
}

export async function requireAuthenticatedUser(req: Request, base44: any): Promise<GuardResult> {
  let actor: any = null;
  try {
    actor = await base44.auth.me();
  } catch (_) {
    actor = null;
  }

  if (!actor) {
    return { ok: false, response: jsonError(401, 'missing_identity', 'Authenticated user is required') };
  }

  return { ok: true, requestId: requestId(req), actor };
}

type GoogleTokenInfo = {
  aud?: string;
  iss?: string;
  email?: string;
};

export async function requireGmailPubSubOrInternalToken(req: Request, options: GuardOptions = {}): Promise<GuardResult> {
  const internalAttempt = requireInternalToken(req, options);
  if (internalAttempt.ok) return internalAttempt;

  const auth = header(req, 'authorization');
  if (!auth.match(/^Bearer\s+\S+/i)) {
    return { ok: false, response: jsonError(401, 'missing_identity', 'Gmail Pub/Sub authorization is required') };
  }

  const token = auth.replace(/^Bearer\s+/i, '').trim();
  let info: GoogleTokenInfo;
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
    if (!res.ok) {
      return { ok: false, response: jsonError(403, 'insufficient_role', 'Invalid Gmail Pub/Sub token') };
    }
    info = await res.json();
  } catch (_) {
    return { ok: false, response: jsonError(403, 'insufficient_role', 'Gmail Pub/Sub token verification failed') };
  }

  const issuer = info.iss || '';
  if (issuer !== 'https://accounts.google.com' && issuer !== 'accounts.google.com') {
    return { ok: false, response: jsonError(403, 'insufficient_role', 'Gmail Pub/Sub token issuer is invalid') };
  }

  const expectedAudience = Deno.env.get('GMAIL_PUBSUB_AUDIENCE')?.trim();
  if (expectedAudience && info.aud !== expectedAudience) {
    return { ok: false, response: jsonError(403, 'insufficient_role', 'Gmail Pub/Sub token audience is invalid') };
  }

  return { ok: true, requestId: requestId(req) };
}

type HmacVerifyOptions = {
  secretEnv: string;
  signatureHeader?: string;
  prefix?: string;
  rawHex?: boolean;
};

export async function verifyHmacSha256(
  rawBody: string,
  req: Request,
  options: HmacVerifyOptions,
): Promise<GuardResult> {
  const secret = requiredSecret(options.secretEnv);
  if (!secret) {
    return { ok: false, response: jsonError(500, 'server_misconfigured', `${options.secretEnv} is required`) };
  }

  const headerName = options.signatureHeader || 'x-signature';
  const signatureHeader = header(req, headerName);
  if (!signatureHeader) {
    return { ok: false, response: jsonError(401, 'missing_identity', `${headerName} is required`) };
  }

  let receivedHex = signatureHeader.trim();
  if (options.prefix) {
    const [algorithm, hex] = receivedHex.split('=');
    if (algorithm !== options.prefix || !hex) {
      return { ok: false, response: jsonError(403, 'insufficient_role', `${headerName} format is invalid`) };
    }
    receivedHex = hex;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const computedHex = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (!secretsMatch(computedHex, receivedHex)) {
    return { ok: false, response: jsonError(403, 'insufficient_role', `${headerName} is invalid`) };
  }

  return { ok: true, requestId: requestId(req) };
}

export function auditInvocation(functionName: string, guard: GuardSuccess, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({
    event: 'sec06_invocation',
    functionName,
    requestId: guard.requestId,
    idempotencyKey: guard.idempotencyKey,
    ...fields,
  }));
}
