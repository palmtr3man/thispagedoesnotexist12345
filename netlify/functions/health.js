/**
 * /api/health — Lightweight health check endpoint (PAL-39 fix)
 *
 * Returns 200 OK with a minimal JSON payload so the .com Cutover
 * Go/No-Go checklist health gate passes within the 5000 ms latency budget.
 *
 * PAL-39: https://linear.app/palmtree-studios/issue/PAL-39
 */
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({ status: "ok", ts: Date.now() }),
  };
};
