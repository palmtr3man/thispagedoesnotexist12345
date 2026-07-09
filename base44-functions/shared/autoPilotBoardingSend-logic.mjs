/**
 * Pure guard + routing logic for autoPilotBoardingSend.
 * Canonical copy lives in career-navigator:
 *   base44/functions/shared/autoPilotBoardingSend-logic.mjs
 *
 * Keep in sync with palmtr3man/career-navigator (Base44 git deploy source).
 */

/**
 * @param {{
 *   autoPilotEnabled?: boolean,
 *   seat?: Record<string, unknown> | null,
 *   eventEntityId?: string,
 * }} input
 */
export function evaluateAutoPilotBoardingSend(input) {
  const { autoPilotEnabled, seat, eventEntityId } = input;

  if (!autoPilotEnabled) {
    return { action: 'skip', reason: 'auto_pilot_disabled' };
  }

  if (!seat) {
    return { action: 'error', status: 404, body: { error: 'seat_not_found' } };
  }

  if (seat.status !== 'opened') {
    return { action: 'skip', reason: 'status_not_opened', status: seat.status };
  }

  const email = String(seat.user_email || '').trim();
  if (!email) {
    return {
      action: 'error',
      status: 400,
      body: { error: 'missing_user_email', seat_id: seat.id },
    };
  }

  if (seat.boarding_confirmation_sent_at) {
    return { action: 'skip', reason: 'already_sent', seat_id: seat.id };
  }

  return {
    action: 'delegate',
    seatPayload: {
      ...seat,
      id: seat.id || eventEntityId,
      boarding_type: seat.boarding_type || 'standard',
    },
  };
}
