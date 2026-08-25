import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handler } = require('./lib/alignment-loop-impl.cjs');

export default async function alignmentLoop(request, context) {
  const url = new URL(request.url);
  const event = {
    httpMethod: request.method,
    headers: Object.fromEntries(request.headers),
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.text(),
    isBase64Encoded: false,
    path: url.pathname,
    requestContext: context,
  };

  const result = await handler(event, context);
  return new Response(result.body ?? '', {
    status: result.statusCode ?? 200,
    headers: result.headers ?? { 'Content-Type': 'application/json' },
  });
}
