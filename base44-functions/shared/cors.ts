import { requiredCsvEnv } from './config.ts';

export function getAllowedOrigins(): string[] {
  return requiredCsvEnv('ALLOWED_ORIGINS');
}

export function corsHeadersForRequest(
  req: Request,
  options: { methods?: string; headers?: string } = {},
): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigins = getAllowedOrigins();
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': options.methods || 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': options.headers || 'Content-Type, Authorization, x-internal-token',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };

  if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}
