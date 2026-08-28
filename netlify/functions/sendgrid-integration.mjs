import { handler } from './lib/brevo-integration-impl.cjs';

// Netlify Functions v2 entrypoint. The historical filename is retained for URL compatibility.
export default async (request, context) => handler(request, context);
