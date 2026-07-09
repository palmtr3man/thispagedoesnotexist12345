/**
 * Best-effort caller for notifyTaskFailure from other Base44 scheduled functions.
 * Never throws — alert delivery must not mask the original task error.
 */

import { optionalEnv } from './config.ts';

type NotifyPayload = {
  task: string;
  error: string;
  details?: unknown;
};

export async function notifyTaskFailureBestEffort(payload: NotifyPayload): Promise<void> {
  const url = optionalEnv('NOTIFY_TASK_FAILURE_URL');
  const token = optionalEnv('SEC06_INTERNAL_TOKEN');
  if (!url || !token) {
    console.warn('[notifyTaskFailureClient] NOTIFY_TASK_FAILURE_URL or SEC06_INTERNAL_TOKEN not set — skipping alert');
    return;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': token,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('[notifyTaskFailureClient] alert failed', res.status, text);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[notifyTaskFailureClient]', message);
  }
}
