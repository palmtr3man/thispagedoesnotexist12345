/**
 * #116 — handleSeatOpened / sendSeatConfirmation
 * Netlify Function: sendgrid-integration
 *
 * Triggered when a Seat entity is activated (admin approves a SeatRequest).
 * Dispatches the boarding sequence in order based on boarding_type:
 *   - Alpha / default: alphaflightannouncement_v1 → boarding_confirmation_v1
 *   - VIP cohort: vip_boarding_pass_v1 → vip_boarding_instructions_v1
 *
 * After both sends confirm 2xx, stamps boarding_confirmation_sent_at on the
 * Seat record via the Base44 API. Idempotency guard: will not overwrite if
 * the field is already set (guards against retry double-stamps).
 *
 * All sends BCC support@thispagedoesnotexist12345.com per universal BCC rule.
 */

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';
const BCC_EMAIL = 'support@thispagedoesnotexist12345.com';
const MAIN_SITE_URL = 'https://www.thispagedoesnotexist12345.com';
const CANONICAL_FIRST_TIME_PATH = '/OnboardingPassport';
const CANONICAL_RETURN_PATH = '/';
const BRANDING = require('../../branding-constants.js');

const TEMPLATE_ENV = {
  alphaAnnouncement: 'SENDGRID_TEMPLATE_ALPHA_FLIGHT_ANNOUNCEMENT',
  boardingConfirmation: 'SENDGRID_TEMPLATE_BOARDING_CONFIRMATION',
  vipBoardingPass: 'SENDGRID_TEMPLATE_VIP_BOARDING_PASS',
  vipBoardingInstructions: 'SENDGRID_TEMPLATE_VIP_BOARDING_INSTRUCTIONS'
};

const DEFAULT_FLIGHT_DETAILS = {
  alpha: {
    flightCode: process.env.ACTIVE_FLIGHT_CODE || BRANDING.ACTIVE_FLIGHT_CODE || '',
    departureDate: process.env.ACTIVE_FLIGHT_DEPARTURE_DATE || ''
  },
  vip: {
    flightCode: process.env.ACTIVE_FLIGHT_CODE || BRANDING.ACTIVE_FLIGHT_CODE || '',
    departureDate: process.env.ACTIVE_FLIGHT_DEPARTURE_DATE || ''
  }
};

const DISPATCH_LEASE_MS = Math.max(60_000, Number(process.env.BOARDING_CONFIRMATION_DISPATCH_LEASE_MS || 15 * 60 * 1000));

let lastSendgridError = '';

function getTrimmedEnv(name) {
  const value = process.env[name];
  return value ? String(value).trim() : '';
}

function getTemplateIds(boardingType) {
  const keys = boardingType === 'vip'
    ? ['vipBoardingPass', 'vipBoardingInstructions']
    : ['alphaAnnouncement', 'boardingConfirmation'];

  const templateIds = {};
  const missing = [];

  for (const key of keys) {
    const envName = TEMPLATE_ENV[key];
    const value = getTrimmedEnv(envName);
    if (!value) missing.push(envName);
    templateIds[key] = value;
  }

  return { templateIds, missing };
}

function resolveSeatId(seat) {
  return seat.id || seat.seat_id || seat.tuj_code || '';
}

function resolveSeatRecordId(seat) {
  return seat.id || seat.seat_id || seat.record_id || seat.seat_record_id || '';
}

function resolveTujCode(seat, seatId) {
  return seat.tuj_code || seat.seat_id || seatId || '';
}

function resolveRecipient(seat) {
  return seat.user_email || seat.passenger_email || seat.email || '';
}

function resolveFirstName(seat) {
  return seat.first_name || seat.passenger_first_name || (seat.name ? String(seat.name).trim().split(/\s+/)[0] : '');
}

function resolveLastName(seat) {
  return seat.last_name || seat.passenger_last_name || (seat.name ? String(seat.name).trim().split(/\s+/).slice(1).join(' ') : '');
}

function resolveBoardingType(seat) {
  return String(seat.boarding_type || seat.boardingtype || 'first_class').trim().toLowerCase();
}

function isVipBoardingType(boardingType) {
  return boardingType === 'vip' || boardingType === 'bracket.barbie';
}

function parseIso(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isDispatchLeaseActive(boarding_confirmation_dispatch_started_at) {
  if (!boarding_confirmation_dispatch_started_at) return false;
  const startedMs = parseIso(boarding_confirmation_dispatch_started_at);
  if (startedMs === null) return false;
  return Date.now() - startedMs < DISPATCH_LEASE_MS;
}

const CANONICAL_FLIGHT_ID = (process.env.ACTIVE_FLIGHT_CODE || BRANDING.ACTIVE_FLIGHT_CODE || 'FL-CG-000').trim() || 'FL-CG-000';

function resolveFlightCode(...values) {
  for (const value of values) {
    const rawValue = String(value ?? '').trim();
    if (!rawValue) continue;

    if (/^FL(?:[\s-]?VIP)?[\s-]?(?:051126|CG[-_\s]?000)$/i.test(rawValue)) {
      return CANONICAL_FLIGHT_ID || 'FL-CG-000';
    }

    return rawValue;
  }
  return CANONICAL_FLIGHT_ID || 'FL-CG-000';
}

function resolveFlightCodeForSeat(seat) {
  return resolveFlightCode(
    seat.flight_code,
    seat.flightcode,
    seat.flight_id,
    seat.flight_label,
    seat.flight_number
  );
}

function resolveCabinClass(seat, isVipBoarding) {
  const rawValue = String(seat.cabin_class || seat.cabin || seat.passenger_cabin_class || seat.cabin_type || seat.boarding_type || '').trim().toLowerCase();
  if (rawValue === 'first' || rawValue === 'first_class' || rawValue === 'paid' || rawValue === 'vip') return 'First';
  if (rawValue === 'sponsored') return 'Sponsored';
  if (rawValue === 'economy' || rawValue === 'free' || rawValue === 'standard' || rawValue === 'alpha') return 'Economy';
  return isVipBoarding ? 'First' : 'Economy';
}

function resolveDepartureDate(seat, isVipBoarding) {
  return seat.departure_date || seat.scheduled_departure_date || DEFAULT_FLIGHT_DETAILS[isVipBoarding ? 'vip' : 'alpha'].departureDate || '';
}

function resolveSeatsAvailable(seat) {
  const value = seat.seats_available ?? seat.remaining_seats ?? seat.available_seats ?? 1;
  return typeof value === 'number' ? value : String(value);
}

function buildAlphaDynamicData(seat) {
  const seatId = resolveSeatId(seat);
  const seatRecordId = resolveSeatRecordId(seat);
  const tujCode = resolveTujCode(seat, seatId);
  const canonicalSeatId = tujCode || seatId;
  const flightCode = resolveFlightCodeForSeat(seat);

  return {
    first_name: resolveFirstName(seat),
    last_name: resolveLastName(seat),
    user_email: resolveRecipient(seat),
    seat_id: seatId,
    tuj_code: tujCode,
    flight_code: flightCode,
    flightcode: flightCode,
    flight_id: flightCode,
    cabin_class: resolveCabinClass(seat, false),
    departure_date: resolveDepartureDate(seat, false),
    seats_available: resolveSeatsAvailable(seat),
    first_task_url: seat.first_task_url || `${MAIN_SITE_URL}${CANONICAL_FIRST_TIME_PATH}?seat_id=${encodeURIComponent(canonicalSeatId)}&tuj_code=${encodeURIComponent(tujCode)}`,
    secondary_url: seat.secondary_url || `${MAIN_SITE_URL}${CANONICAL_RETURN_PATH}?seat_id=${encodeURIComponent(canonicalSeatId)}&tuj_code=${encodeURIComponent(tujCode)}&flight_id=${encodeURIComponent(flightCode)}`,
    unsubscribe_url: seat.unsubscribe_url || getTrimmedEnv('SENDGRID_UNSUBSCRIBE_URL') || `${MAIN_SITE_URL}/unsubscribe`,
    boarding_type: 'alpha',
    boardingtype: 'alpha',
    seats_reserved: 'F5-04'
  };
}

function buildVipDynamicData(seat) {
  const seatId = resolveSeatId(seat);
  const tujCode = resolveTujCode(seat, seatId);
  const canonicalSeatId = tujCode || seatId;
  const flightCode = resolveFlightCodeForSeat(seat);

  return {
    first_name: resolveFirstName(seat),
    last_name: resolveLastName(seat),
    user_email: resolveRecipient(seat),
    seat_id: seatId,
    tuj_code: tujCode,
    flight_code: flightCode,
    flightcode: flightCode,
    flight_id: flightCode,
    cabin_class: resolveCabinClass(seat, true),
    departure_date: resolveDepartureDate(seat, true),
    seats_available: resolveSeatsAvailable(seat),
    first_task_url: seat.first_task_url || `${MAIN_SITE_URL}${CANONICAL_FIRST_TIME_PATH}?seat_id=${encodeURIComponent(canonicalSeatId)}&tuj_code=${encodeURIComponent(tujCode)}`,
    secondary_url: seat.secondary_url || `${MAIN_SITE_URL}${CANONICAL_RETURN_PATH}?seat_id=${encodeURIComponent(canonicalSeatId)}&tuj_code=${encodeURIComponent(tujCode)}&flight_id=${encodeURIComponent(flightCode)}`,
    unsubscribe_url: seat.unsubscribe_url || getTrimmedEnv('SENDGRID_UNSUBSCRIBE_URL') || `${MAIN_SITE_URL}/unsubscribe`,
    boarding_type: 'vip',
    boardingtype: 'vip',
    seats_reserved: 'F5-04',
    newsletter_brand: 'VIP cohort',
    newsletter_promo: 'Mission Control promo'
  };
}

/**
 * Send a single SendGrid dynamic template email.
 * Returns true on 2xx, false otherwise.
 */
async function sendTemplate(apiKey, fromEmail, toEmail, templateId, dynamicData) {
  const payload = {
    from: { email: fromEmail },
    personalizations: [{
      to: [{ email: toEmail }],
      bcc: [{ email: BCC_EMAIL }],
      dynamic_template_data: dynamicData
    }],
    template_id: templateId
  };

  try {
    const response = await fetch(SENDGRID_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok || response.status === 202) {
      console.log(`[sendgrid-integration] Template ${templateId} sent to ${toEmail} — status ${response.status}`);
      return true;
    }

    const errorText = await response.text();
    lastSendgridError = errorText;
    console.error(`[sendgrid-integration] Template ${templateId} failed for ${toEmail} — status ${response.status}:`, errorText);
    return false;
  } catch (error) {
    lastSendgridError = String(error && error.message ? error.message : error);
    console.error(`[sendgrid-integration] Template ${templateId} fetch failed for ${toEmail}:`, error);
    return false;
  }
}

/**
 * Write a field update back to a Seat record via the Base44 API.
 */
async function updateSeatRecord(base44SeatUrl, seatId, fields) {
  const url = `${base44SeatUrl}/${seatId}`;
  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[sendgrid-integration] Base44 Seat update failed for seat ${seatId} — status ${response.status}:`, errorText);
      return false;
    }

    console.log(`[sendgrid-integration] Seat record ${seatId} updated:`, Object.keys(fields).join(', '));
    return true;
  } catch (error) {
    console.error(`[sendgrid-integration] Base44 Seat update fetch failed for seat ${seatId}:`, error);
    return false;
  }
}

/**
 * sendSeatConfirmation — core boarding sequence dispatcher.
 *
 * Fires the appropriate boarding sequence in order. If both sends return 2xx,
 * stamps boarding_confirmation_sent_at on the Seat record. Idempotent:
 * skips the stamp if boarding_confirmation_sent_at is already set.
 */
async function sendSeatConfirmation(seat) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@thispagedoesnotexist12345.com';
  const base44SeatUrl = process.env.BASE44_SEAT_URL;

  if (!apiKey) {
    console.error('[sendgrid-integration] SENDGRID_API_KEY is not set — aborting');
    return { success: false, error: 'SENDGRID_API_KEY not configured' };
  }

  const seatId = resolveSeatId(seat);
  const tujCode = resolveTujCode(seat, seatId);
  const recipientEmail = resolveRecipient(seat);
  const firstName = resolveFirstName(seat);
  const lastName = resolveLastName(seat);
  const boardingType = resolveBoardingType(seat);
  const isVipBoarding = isVipBoardingType(boardingType);
  const boardingConfirmationSentAt = seat.boarding_confirmation_sent_at || seat.boardingconfirmationsentat;
  const boardingConfirmationDispatchStartedAt = seat.boarding_confirmation_dispatch_started_at || seat.boardingconfirmationdispatchstartedat;

  if (!seatId || !tujCode || !recipientEmail || !firstName || !lastName) {
    console.error(`[sendgrid-integration] Seat ${seatId || tujCode || 'unknown'} missing required fields (recipientEmail, firstName, lastName, tuj_code) — aborting`);
    return { success: false, error: 'Missing required seat fields' };
  }

  if (boardingConfirmationSentAt) {
    console.log(`[sendgrid-integration] Seat ${seatId} already has boarding_confirmation_sent_at (${boardingConfirmationSentAt}) — skipping send`);
    return { success: true, skipped: true };
  }

  if (isDispatchLeaseActive(boardingConfirmationDispatchStartedAt)) {
    console.log(`[sendgrid-integration] Seat ${seatId} already has active boarding_confirmation_dispatch_started_at (${boardingConfirmationDispatchStartedAt}) — skipping send`);
    return { success: true, skipped: true };
  }

  const dispatchStartedAt = boardingConfirmationDispatchStartedAt || new Date().toISOString();

  const { templateIds, missing } = getTemplateIds(isVipBoarding ? 'vip' : 'alpha');
  if (missing.length) {
    console.error(`[sendgrid-integration] Missing SendGrid template env vars: ${missing.join(', ')}`);
    return { success: false, error: `Missing template env vars: ${missing.join(', ')}` };
  }

  const dynamicData = isVipBoarding ? buildVipDynamicData(seat) : buildAlphaDynamicData(seat);
  const sequence = isVipBoarding
    ? [
        { label: 'vip_boarding_pass_v1', templateId: templateIds.vipBoardingPass },
        { label: 'vip_boarding_instructions_v1', templateId: templateIds.vipBoardingInstructions }
      ]
    : [
        { label: 'alphaflightannouncement_v1', templateId: templateIds.alphaAnnouncement },
        { label: 'boarding_confirmation_v1', templateId: templateIds.boardingConfirmation }
      ];

  for (const step of sequence) {
    const sent = await sendTemplate(apiKey, fromEmail, recipientEmail, step.templateId, dynamicData);
    if (!sent) {
      console.error(`[sendgrid-integration] ${step.label} failed for seat ${seatId} — aborting sequence`);
      return { success: false, error: `${step.label} send failed${lastSendgridError ? `: ${lastSendgridError}` : ''}` };
    }
  }

  if (base44SeatUrl && seatId) {
    const boardingConfirmationSentAtValue = new Date().toISOString();
    const flightCode = resolveFlightCodeForSeat(seat);
    await updateSeatRecord(base44SeatUrl, seatId, {
      boarding_confirmation_sent_at: boardingConfirmationSentAtValue,
      boardingconfirmationsentat: boardingConfirmationSentAtValue,
      boarding_confirmation_dispatch_started_at: dispatchStartedAt,
      boardingconfirmationdispatchstartedat: dispatchStartedAt,
      boarding_confirmation_dispatch_state: 'sent',
      boardingconfirmationdispatchstate: 'sent',
      tuj_code: tujCode,
      flight_code: flightCode,
      flightcode: flightCode,
      flight_id: flightCode,
      boarding_type: boardingType,
      boardingtype: boardingType,
      seats_reserved: 'F5-04'
    });
  } else {
    console.warn('[sendgrid-integration] BASE44_SEAT_URL not set — boarding_confirmation_sent_at stamp skipped');
  }

  return { success: true };
}

/**
 * handleSeatOpened — Netlify Function handler.
 *
 * Accepts a POST with the full Seat entity record in the request body.
 * Delegates to sendSeatConfirmation for the email sequence and stamp.
 */
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  let seat;
  try {
    seat = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  if (!seat || (!seat.id && !seat.seat_id && !seat.tuj_code)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Missing seat.id or tuj_code in request body' }) };
  }

  const result = await sendSeatConfirmation(seat);

  if (!result.success) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ ok: false, error: result.error })
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, skipped: result.skipped || false })
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports.sendSeatConfirmation = sendSeatConfirmation;
  module.exports.sendTemplate = sendTemplate;
  module.exports.updateSeatRecord = updateSeatRecord;
}
