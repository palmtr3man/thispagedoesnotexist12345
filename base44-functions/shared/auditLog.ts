/** Audit log helpers for Base44 Deno functions (reference copy for deploy parity). */

type AuditOutcome = 'success' | 'failure';

export interface AuditLogEntry {
  eventName: string;
  operationType: string;
  actorId?: string;
  actorRole?: string;
  requestId: string;
  targetEntity?: string;
  targetId?: string;
  outcome: AuditOutcome;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
}

export function auditRequestId(req: Request): string {
  const header = req.headers.get('x-request-id')?.trim();
  if (header) return header;
  return crypto.randomUUID();
}

export async function writeAuditLog(
  base44: { asServiceRole: { entities: { AuditLog: { create: (payload: Record<string, unknown>) => Promise<unknown> } } } },
  entry: AuditLogEntry,
): Promise<void> {
  try {
    await base44.asServiceRole.entities.AuditLog.create({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[auditLog] write failed (non-fatal):', message);
  }
}
