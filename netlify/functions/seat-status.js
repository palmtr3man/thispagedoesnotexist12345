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

export default async function handler(req, context) {
  try {
    const res = await fetch(process.env.BASE44_COHORT_STATUS_URL);
    if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
    const data = await res.json();
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
