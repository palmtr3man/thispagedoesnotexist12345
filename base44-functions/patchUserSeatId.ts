import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { firstRequiredEnv } from './shared/config.ts';
import { ENV_ALIASES } from './shared/platformSecrets.ts';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user || user.role !== 'admin') {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const tujCode = firstRequiredEnv(...ENV_ALIASES.pilotSeatId);

  // Patch the calling user's passport_seat_id to the canonical TUJ code
  await base44.auth.updateMe({ passport_seat_id: tujCode });

  return Response.json({ ok: true, passport_seat_id: tujCode });
});
