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
 * CORS headers are already set on the Base44 side; this proxy passes the
 * response through cleanly. Falls back to gate_status: 'closed' on any error.
 */

exports.handler = async function handler(req, context) {
  try {
    const res = await fetch(process.env.BASE44_COHORT_STATUS_URL);
    if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
    const data = await res.json();
    const alphaModeEnv = String(process.env.ALPHA_MODE || '').toLowerCase();
    if (alphaModeEnv === 'false') {
      data.alpha_mode = false;
      if (typeof data.flight_label === 'string' && /alpha/i.test(data.flight_label)) {
        data.flight_label = data.flight_label.replace(/alpha/i, 'Beta');
      } else {
        data.flight_label = 'Beta Flight';
      }
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gate_status: 'closed', error: err.message })
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports.handler = exports.handler;
}
