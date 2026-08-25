export type BmacPayload = Record<string, any>;
export function requirePost(req: Request): Response | null {
  return req.method === 'POST' ? null : Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } });
}
export function normalizeBmacPayload(payload: BmacPayload) {
  const data = payload?.data ?? {};
  const email = String(payload.supporter_email ?? data?.supporter?.email ?? data?.email ?? '').trim().toLowerCase();
  const eventType = String(payload.type ?? payload.event_type ?? data?.type ?? '').trim().toLowerCase();
  const eventId = String(payload.id ?? payload.event_id ?? payload.eventId ?? data?.id ?? data?.event_id ?? '').trim();
  return { email, eventType, eventId, data };
}
export async function claimBmacEvent(base44: any, eventId: string, handler: string, payload: BmacPayload) {
  if (!eventId) throw new Error('Missing BMAC event ID');
  const entity = base44.asServiceRole.entities.BmacWebhookEvent;
  try {
    const row = await entity.create({ event_id: eventId, handler, status: 'processing', payload, claimed_at: new Date().toISOString() });
    return { claimed: true, row };
  } catch (error) {
    const rows = await entity.filter({ event_id: eventId, handler });
    const existing = rows?.[0];
    if (existing?.status === 'completed') return { claimed: false, duplicate: true, row: existing };
    if (existing?.status === 'processing') return { claimed: false, inFlight: true, row: existing };
    if (existing) {
      await entity.update(existing.id, { status: 'processing', claimed_at: new Date().toISOString(), last_error: null });
      return { claimed: true, row: existing };
    }
    throw error;
  }
}
export async function completeBmacEvent(base44: any, row: any, result?: any) {
  await base44.asServiceRole.entities.BmacWebhookEvent.update(row.id, { status: 'completed', completed_at: new Date().toISOString(), result: result ?? null });
}
export async function failBmacEvent(base44: any, row: any, error: unknown) {
  await base44.asServiceRole.entities.BmacWebhookEvent.update(row.id, { status: 'failed', failed_at: new Date().toISOString(), last_error: error instanceof Error ? error.message : String(error) });
}
