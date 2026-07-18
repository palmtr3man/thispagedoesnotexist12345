/**
 * alignment-loop.js — Netlify Function (Scheduled)
 */

'use strict';

const { runAlignmentLoop } = require('../shared/alignment-core.js');
const { notifyTaskFailure } = require('../shared/notify-task-failure.cjs');
const { validateAlignmentLoopTrigger } = require('../shared/sec06-auth.js');

exports.handler = async function handler(event) {
  // Auth gate - only allow scheduled or internal trigger
  const triggerType = validateAlignmentLoopTrigger(event);
  if (!triggerType) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized — invalid or missing trigger secret.' }),
    };
  }

  try {
    const results = await runAlignmentLoop();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        trigger: triggerType,
        ran_at: new Date().toISOString(),
        ...results,
      }),
    };
  } catch (err) {
    await notifyTaskFailure({
      task: 'alignment-loop',
      error: err.message,
      details: { trigger: triggerType },
    });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
