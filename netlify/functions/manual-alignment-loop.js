/**
 * manual-alignment-loop.js — Netlify Function (Manual Trigger)
 */

'use strict';

const { runAlignmentLoop } = require('./shared/alignment-core.js');
const { notifyTaskFailure } = require('./shared/notify-task-failure.cjs');
const { validateAdminHeader } = require('./shared/sec06-auth.js');

exports.handler = async function handler(event) {
  // OPTIONS preflight
  if ((event.httpMethod || '').toUpperCase() === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-internal-token',
      },
      body: '',
    };
  }

  // Auth gate - only allow internal token
  if (!validateAdminHeader(event)) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized — manual trigger requires valid internal token.' }),
    };
  }

  try {
    const results = await runAlignmentLoop();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        trigger: 'manual',
        ran_at: new Date().toISOString(),
        ...results,
      }),
    };
  } catch (err) {
    await notifyTaskFailure({
      task: 'alignment-loop (manual)',
      error: err.message,
      details: { trigger: 'manual' },
    });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
