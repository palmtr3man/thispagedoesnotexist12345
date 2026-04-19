/**
 * seat-status.js — Netlify Function (Option 1: Proxy)
 *
 * Proxies the Base44 getCohortStatus function and returns live seat
 * availability and gate state to the landing page.
 *
 * F117 — Carousel + Dock Source of Truth:
 *   Adds `ok`, `opencount` (alias for open_count), and `seats` array to the
 *   success response. The `seats` array is the canonical per-seat list used
 *   by the carousel seat slide and any UI that needs individual seat state.
 *
 *   `seats` is built from BASE44_SEAT_LIST_URL when set (live Base44 query),
 *   or synthesised from the aggregate counts in the getCohortStatus response
 *   when BASE44_SEAT_LIST_URL is not configured. Synthesis preserves the
 *   stable order (seat_1 → seat_5) required by the spec.
 *
 * Required env var:
 *   BASE44_COHORT_STATUS_URL — the public URL of the Base44 getCohortStatus function
 *                              (Base44 Dashboard → Code → Functions → getCohortStatus)
 *
 * Optional env vars:
 *   PUBLIC_GATE_STATE      — operator override for the public gate state.
 *                            When set, overrides the gate_status field in the
 *                            upstream Base44 response before returning to the client.
 *                            Accepted values: 'open', 'hold', 'closed', 'boarding'
 *                            Example: PUBLIC_GATE_STATE=hold → gate_status: 'hold'
 *                            Fixes QA #1 (landing page gate label) + QA #6 (CTA suppression).
 *   BASE44_SEAT_LIST_URL   — Base44 Seat entity list endpoint (returns array of seat records
 *                            for the active flight). When set, the `seats` array in the
 *                            response is populated from live seat records. When unset, the
 *                            `seats` array is synthesised from getCohortStatus aggregate counts.
 *                            Format: https://<base44-host>/api/Seat?flight_id=<flight_code>
 *                            or the Base44 function URL that returns the full seat list.
 *
 * CORS headers are already set on the Base44 side; this proxy passes the
 * response through cleanly. Falls back to gate_status: 'closed' on any error.
 *
 * Guard layers — evaluated in order:
 *
 * F-VIP-01 — VIP flight privacy (Layer 2 of 2):
 *   If getCohortStatus returns a VIP flight (flight_type === 'vip'), it means
 *   the Base44 filter (Layer 1, in getCohortStatus entry.ts) was bypassed via
 *   a direct DB write. This proxy returns HTTP 451 with gate_status: 'closed'
 *   so the UI shows the next scheduled public departure instead of surfacing
 *   the VIP flight. VIP flights are never broadcast publicly.
 *   Layer 1: getCohortStatus Base44 function — flight_type filter on both queries.
 *   451 = "Unavailable For Legal Reasons" — semantically: intentionally withheld.
 *
 * QA #7 — QA flight isolation (API layer):
 *   If the upstream response indicates the active flight is a QA flight
 *   (flight_mode === 'qa'), this function returns HTTP 422 with
 *   gate_status: 'qa_isolation_violation' so the UI can surface a safe
 *   fallback. QA flights must never drive the public .com page.
 *   DB layer: Supabase partial unique index (supabase/migrations/20260331_qa_flight_isolation.sql)
 *
 * QA #5 — Single active flight invariant (Layer 2 of 3):
 *   If the upstream response signals more than one active flight
 *   (active_flight_count > 1), this function returns HTTP 409 with
 *   gate_status: 'conflict' so the UI can surface a safe fallback
 *   instead of silently showing ambiguous seat data.
 *   Layer 1: Supabase partial unique index (supabase/migrations/20260331_single_active_flight_invariant.sql)
 *   Layer 3: UI fallback in index.html applySeatGate()
 */

const SEAT_LIST_TIMEOUT_MS = 3000; // 3 s — fast enough for UX; generous enough for cold starts
const MAX_SEATS            = 5;    // canonical cohort size

/**
 * buildSeatsArray — Build the canonical seats array for the F117 response.
 *
 * Strategy (in order of preference):
 *   1. BASE44_SEAT_LIST_URL is set → fetch live seat records from Base44.
 *      Expects the endpoint to return an array of objects with at least
 *      { id, status } (or { seat_label, status }). Returns up to MAX_SEATS
 *      records in stable order.
 *   2. Fallback → synthesise from getCohortStatus aggregate counts.
 *      Fills `opened` seats first, then `approved`, then `pending`.
 *      IDs are synthetic: seat_1 … seat_5.
 *
 * @param {object} cohortData - Parsed getCohortStatus response.
 * @returns {Promise<Array<{id: string, status: string}>>}
 */
async function buildSeatsArray(cohortData) {
  const seatListUrl = process.env.BASE44_SEAT_LIST_URL;

  if (seatListUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEAT_LIST_TIMEOUT_MS);
      const res = await fetch(seatListUrl, {
        method:  'GET',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const raw = await res.json();
        // Accept both a bare array and a { seats: [...] } envelope
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.seats) ? raw.seats : []);
        if (list.length > 0) {
          // Normalise to { id, status } — accept seat_label as id fallback
          const normalised = list.slice(0, MAX_SEATS).map((s, i) => ({
            id:     s.id ?? s.seat_label ?? `seat_${i + 1}`,
            status: s.status ?? 'pending',
          }));
          // Pad to MAX_SEATS with pending placeholders if fewer seats returned
          while (normalised.length < MAX_SEATS) {
            normalised.push({ id: `seat_${normalised.length + 1}`, status: 'pending' });
          }
          return normalised;
        }
      }
    } catch (_) {
      // Timeout or fetch error — fall through to synthetic fallback
    }
  }

  // ── Synthetic fallback ──────────────────────────────────────────────────────
  // Build a stable 5-seat array from getCohortStatus aggregate counts.
  // Fill order: opened → approved → pending.
  const openCount     = typeof cohortData.open_count     === 'number' ? cohortData.open_count     : 0;
  const approvedCount = typeof cohortData.approved_count === 'number' ? cohortData.approved_count : 0;
  const seats         = [];
  for (let i = 0; i < MAX_SEATS; i++) {
    let status = 'pending';
    if (i < openCount)                        status = 'opened';
    else if (i < openCount + approvedCount)   status = 'approved';
    seats.push({ id: `seat_${i + 1}`, status });
  }
  return seats;
}

export default async function handler(req, context) {
  try {
    // Append ?flight_id= so getCohortStatus uses the 'explicit' resolution path
    // instead of falling through to 'latest_active'. ACTIVE_FLIGHT_CODE is the
    // canonical source of truth for the current flight (e.g. FL_041926).
    // Spaces are normalised to underscores per the Flight ID formatting convention.
    const cohortBaseUrl     = process.env.BASE44_COHORT_STATUS_URL;
    const activeFlightCode  = (process.env.ACTIVE_FLIGHT_CODE || '').replace(/\s+/g, '_');
    const cohortUrl         = activeFlightCode
      ? `${cohortBaseUrl}${cohortBaseUrl.includes('?') ? '&' : '?'}flight_id=${encodeURIComponent(activeFlightCode)}`
      : cohortBaseUrl;
    const res = await fetch(cohortUrl);
    if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
    const data = await res.json();

    // ── F-VIP-01 — VIP flight privacy guard (Layer 2 of 2) ──────────────────
    // VIP flights must never be surfaced to the public .com gate.
    // If getCohortStatus returns flight_type === 'vip', the Base44 filter
    // was bypassed. Return 451 with gate_status: 'closed' — scheduling fields
    // (nextflightdeparturedate, nextflightstatus) are preserved so the
    // "Next Departure" badge still shows the correct upcoming public window.
    if (data.flight_type === 'vip') {
      return new Response(
        JSON.stringify({
          ok:                      false,
          gate_status:             'closed',
          flight_type:             'vip',
          flight_label:            null,           // VIP label never exposed
          seats_available:         false,
          open_count:              0,
          opencount:               0,              // F117 alias
          approved_count:          0,
          seats_remaining:         0,
          seats:                   Array.from({ length: MAX_SEATS }, (_, i) => ({ id: `seat_${i + 1}`, status: 'pending' })),
          // Preserve scheduling so "Next Departure" badge still works
          nextflightdeparturedate: data.nextflightdeparturedate ?? null,
          nextflightarrivaldate:   data.nextflightarrivaldate   ?? null,
          nextflightstatus:        data.nextflightstatus         ?? 'SCHEDULED',
          customstatusmessage:     null,
          intake_mode:             data.intake_mode              ?? 'SENDGRID',
          timestamp:               new Date().toISOString(),
          _vip_suppressed:         true,           // debug flag — not shown in UI
        }),
        {
          status: 451,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // ── QA #7 — QA flight isolation ──────────────────────────────────────────
    // If the active flight has flight_mode === 'qa', it must never drive
    // the public .com page. Return 422 with gate_status: 'qa_isolation_violation'
    // so the UI can surface a safe fallback. This catches the case where the
    // Supabase DB constraint (no_active_qa_flight index) has not yet been applied
    // or is bypassed via a direct DB write.
    if (data.flight_mode === 'qa') {
      return new Response(
        JSON.stringify({
          ok:          false,
          gate_status: 'qa_isolation_violation',
          flight_mode: 'qa',
          error: 'Active flight is a QA flight — QA flights must never drive the public .com page.',
        }),
        {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // ── QA #5 — Layer 2: multiple active flights guard ───────────────────────
    // If Base44 returns active_flight_count > 1, the single-active-flight
    // invariant has been violated at the DB level (or the Supabase index
    // has not yet been applied). Return 409 so the UI shows a safe fallback
    // rather than ambiguous seat data.
    if (typeof data.active_flight_count === 'number' && data.active_flight_count > 1) {
      return new Response(
        JSON.stringify({
          ok:                  false,
          gate_status:         'conflict',
          active_flight_count: data.active_flight_count,
          error: 'Multiple active flights detected — single-active-flight invariant violated.',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // ── PUBLIC_GATE_STATE override ───────────────────────────────────────────
    // Operator-controlled gate switch. When set, this value takes precedence
    // over whatever Base44 returns for gate_status. The landing page resolver
    // and CTA logic both read gate_status from this response, so this single
    // injection point fixes both the hero label (QA #1) and the seat CTA
    // suppression (QA #6).
    const gateOverride = process.env.PUBLIC_GATE_STATE;
    if (gateOverride) {
      data.gate_status = gateOverride.toLowerCase();
    }

    // ── F117 — Build seats array ─────────────────────────────────────────────
    // Fetch individual seat records (or synthesise from aggregate counts).
    // Non-blocking: if the seat list fetch fails, the synthetic fallback is used.
    const seats = await buildSeatsArray(data);

    // ── F117 — Augment response with ok, opencount alias, seats, timestamp ───
    // getCohortStatus already returns `timestamp` and `open_count`; we add:
    //   ok        — canonical success flag (true on the happy path)
    //   opencount — spec alias for open_count (carousel compatibility)
    //   seats     — per-seat array (carousel + dock source of truth)
    // timestamp is already present in getCohortStatus response; ensure it's set.
    const payload = {
      ok:        true,
      opencount: typeof data.open_count === 'number' ? data.open_count : 0,
      seats,
      timestamp: data.timestamp ?? new Date().toISOString(),
      ...data,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok:          false,
        gate_status: 'closed',
        error:       err.message,
        timestamp:   new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
