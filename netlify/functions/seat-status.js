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
 * Optional env var:
 *   PUBLIC_GATE_STATE — operator override for the public gate state.
 *                       When set, overrides the gate_status field in the
 *                       upstream Base44 response before returning to the client.
 *                       Accepted values: 'open', 'hold', 'closed', 'boarding'
 *                       Example: PUBLIC_GATE_STATE=hold → gate_status: 'hold'
 *                       Fixes QA #1 (landing page gate label) + QA #6 (CTA suppression).
 *
 * CORS headers are already set on the Base44 side; this proxy passes the
 * response through cleanly. Falls back to gate_status: 'closed' on any error.
 */

export default async function handler(req, context) {
  try {
    const res = await fetch(process.env.BASE44_COHORT_STATUS_URL);
    if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
    const data = await res.json();

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
