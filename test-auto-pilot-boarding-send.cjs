const assert = require('assert');
const { evaluateAutoPilotBoardingSend } = require('./base44-functions/shared/autoPilotBoardingSend-logic.mjs');

const seat = {
  id: 'seat-uuid-1',
  status: 'opened',
  user_email: 'passenger@example.com',
  cabin_class: 'Economy',
  boarding_type: 'standard',
};

assert.strictEqual(evaluateAutoPilotBoardingSend({ autoPilotEnabled: false, seat }).reason, 'auto_pilot_disabled');
assert.strictEqual(evaluateAutoPilotBoardingSend({ autoPilotEnabled: true, seat: null }).status, 404);
assert.strictEqual(
  evaluateAutoPilotBoardingSend({ autoPilotEnabled: true, seat: { ...seat, status: 'approved' } }).reason,
  'status_not_opened',
);
assert.strictEqual(
  evaluateAutoPilotBoardingSend({ autoPilotEnabled: true, seat: { ...seat, user_email: '' } }).body.error,
  'missing_user_email',
);
assert.strictEqual(
  evaluateAutoPilotBoardingSend({
    autoPilotEnabled: true,
    seat: { ...seat, boarding_confirmation_sent_at: '2026-07-09T12:00:00.000Z' },
  }).reason,
  'already_sent',
);

const proceed = evaluateAutoPilotBoardingSend({
  autoPilotEnabled: true,
  seat,
  eventEntityId: 'seat-uuid-1',
});
assert.strictEqual(proceed.action, 'delegate');
assert.strictEqual(proceed.seatPayload.id, 'seat-uuid-1');
assert.strictEqual(proceed.seatPayload.boarding_type, 'standard');

console.log('test-auto-pilot-boarding-send: ok');
