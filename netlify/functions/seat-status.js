/**
 * seat-status.js — Netlify Function (Option 1: Proxy)
 *
 * Proxies the Base44 getCohortStatus function and returns live seat
 * availability and gate state to the landing page.
 *
 * Required env var:
 *   BASE44_COHORT_STATUS_URL — the public URL of the Base44 getCohortStatus function
 *                              (Base44 Dashboard → Code → Functions → getCohortStatus)
 *
 * Optional env vars:
 *   PUBLIC_GATE_STATE — operator override for the public gate state.
 *                       When set, overrides the gate_status field in the
 *                       upstream Base44 response before returning to the client.
 *                       Accepted values: 'open', 'hold', 'closed', 'boarding'
 *                       Example: PUBLIC_GATE_STATE=hold → gate_status: 'hold'
 *                       Fixes QA #1 (landing page gate label) + QA #6 (CTA suppression).
 *
 * CORS headers are already set on the Base44 side; this proxy passes the
 * response through cleanly. Falls back to gate_status: 'closed' on any error.
 *
 * QA #5 — Single active flight invariant (Layer 2 of 3):
 *   If the upstream response signals more than one active flight
 *   (active_flight_count > 1), this function returns HTTP 409 with
 *   gate_status: 'conflict' so the UI can surface a safe fallback
 *   instead of silently showing ambiguous seat data.
 *   Layer 1: Supabase partial unique index (supabase/migrations/20260331_single_active_flight_invariant.sql)
 *   Layer 3: UI fallback in index.html applySeatGate()
 *
 * QA #7 — QA flight isolation (API layer):
 *   If the upstream response indicates the active flight is a QA flight
 *   (flight_mode === 'qa'), this function returns HTTP 422 with
 *   gate_status: 'qa_isolation_violation' so the UI can surface a safe
 *   fallback. QA flights must never drive the public .com page.
 *   DB layer: Supabase partial unique index (supabase/migrations/20260331_qa_flight_isolation.sql)
 */

export default async function handler(req, context) {
  try {
    const res = await fetch(process.env.BASE44_COHORT_STATUS_URL);
    if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
    const data = await res.json();

    // QA #7 — API guard: QA flight isolation.
    // If the active flight has flight_mode === 'qa', it must never drive
    // the public .com page. Return 422 with gate_status: 'qa_isolation_violation'
    // so the UI can surface a safe fallback. This catches the case where the
    // Supabase DB constraint (no_active_qa_flight index) has not yet been applied
    // or is bypassed via a direct DB write.
    if (data.flight_mode === 'qa') {
      return new Response(
        JSON.stringify({
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

    // QA #5 — Layer 2: 409 guard for multiple active flights.
    // If Base44 returns active_flight_count > 1, the single-active-flight
    // invariant has been violated at the DB level (or the Supabase index
    // has not yet been applied). Return 409 so the UI shows a safe fallback
    // rather than ambiguous seat data.
    if (typeof data.active_flight_count === 'number' && data.active_flight_count > 1) {
      return new Response(
        JSON.stringify({
          gate_status: 'conflict',
          active_flight_count: data.active_flight_count,
          error: 'Multiple active flights detected — single-active-flight invariant violated.',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // PUBLIC_GATE_STATE override — operator-controlled gate switch.
    // When set, this value takes precedence over whatever Base44 returns
    // for gate_status. The landing page resolver and CTA logic both read
    // gate_status from this response, so this single injection point fixes
    // both the hero label (QA #1) and the seat CTA suppression (QA #6).
    const gateOverride = process.env.PUBLIC_GATE_STATE;
    if (gateOverride) {
      data.gate_status = gateOverride.toLowerCase();
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ gate_status: 'closed', error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
