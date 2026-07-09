/**
 * syncBmacMembers — BMAC webhook handler
 *
 * Handles incoming BMAC (Buy Me a Coffee) webhook events and keeps user
 * subscription state in sync with payment reality.
 *
 * Supported BMAC webhook event types:
 *   - membership.started      — new paid membership created
 *   - membership.updated      — tier changed or renewed
 *   - membership.cancelled    — membership cancelled
 *   - membership.expired      — membership lapsed after grace period
 *   - supporter.created       — one-time support payment
 *                              + Alpha/Beta extras purchase
 *
 * Alpha product ID: BMAC_ALPHA_PRODUCT_ID env var
 * Beta  product ID: BMAC_BETA_PRODUCT_ID env var
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';
import { auditInvocation, verifyHmacSha256 } from './shared/invocationGuard.ts';
import { requiredEnv } from './shared/config.ts';

const ALPHA_PRODUCT_ID = requiredEnv('BMAC_ALPHA_PRODUCT_ID');
const BETA_PRODUCT_ID = requiredEnv('BMAC_BETA_PRODUCT_ID');

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const rawBody = await req.text();
    const guard = await verifyHmacSha256(rawBody, req, {
      secretEnv: 'BMAC_WEBHOOK_SECRET',
      signatureHeader: 'x-bmac-signature',
      prefix: 'sha256',
    });
    if (!guard.ok) return guard.response;
    auditInvocation('syncBmacMembers', guard);

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const base44 = createClientFromRequest(req);
    const { type: eventType, data } = payload;
    const now = new Date().toISOString();

    console.log('[syncBmacMembers] Received event:', eventType);

    // Resolve user from email
    const supporterEmail = (data?.supporter?.email || data?.email || '').toLowerCase().trim();
    if (!supporterEmail) {
      console.error('[syncBmacMembers] No email in payload.');
      return Response.json({ received: true, action: 'no_email' });
    }

    const users = await base44.asServiceRole.entities.User.filter({ email: supporterEmail });
    if (!users || users.length === 0) {
      console.warn('[syncBmacMembers] No user found for email:', supporterEmail);
      return Response.json({ received: true, action: 'no_user_found' });
    }
    const user = users[0];

    if (eventType === 'membership.started' || eventType === 'membership.updated') {
      const bmacTierName = data?.membership_level?.name || data?.tier_name || null;
      let tier = 'free';
      if (bmacTierName === 'First Cabin')    tier = 'pro';
      else if (bmacTierName === 'Business Cabin') tier = 'plus';
      else if (user.cabin_class === 'First')      tier = 'pro';
      else if (user.cabin_class === 'Business')   tier = 'plus';

      await base44.asServiceRole.entities.User.update(user.id, {
        bmac_payment_confirmed: true,
        bmac_confirmed_at: now,
        bmac_member_id: data?.supporter?.id || null,
      });

      const existingSubs = await base44.asServiceRole.entities.Subscription.filter({ user_id: user.id });
      if (existingSubs.length > 0) {
        await base44.asServiceRole.entities.Subscription.update(existingSubs[0].id, { tier, status: 'active' });
      } else {
        await base44.asServiceRole.entities.Subscription.create({ user_id: user.id, tier, status: 'active' });
      }

      console.log('[syncBmacMembers] Membership active:', { email: supporterEmail, tier });

    } else if (eventType === 'supporter.created') {
      const productId = String(
        data?.extras_id || data?.product_id || data?.extras?.id || data?.item?.id || ''
      );
      const isAlpha = productId === ALPHA_PRODUCT_ID;
      const isBeta  = productId === BETA_PRODUCT_ID;

      if (isAlpha || isBeta) {
        const phase = isAlpha ? 'alpha' : 'beta';
        await base44.asServiceRole.entities.User.update(user.id, {
          cabin_class: 'First',
          flight_phase: phase,
          bmac_payment_confirmed: true,
          bmac_confirmed_at: now,
          bmac_member_id: data?.supporter?.id || null,
        });
        const existingSubs = await base44.asServiceRole.entities.Subscription.filter({ user_id: user.id });
        if (existingSubs.length > 0) {
          await base44.asServiceRole.entities.Subscription.update(existingSubs[0].id, { tier: 'pro', status: 'active' });
        } else {
          await base44.asServiceRole.entities.Subscription.create({ user_id: user.id, tier: 'pro', status: 'active' });
        }
        console.log('[syncBmacMembers] Cohort purchase:', { email: supporterEmail, phase });
      } else {
        // Standard one-time supporter
        await base44.asServiceRole.entities.User.update(user.id, {
          bmac_payment_confirmed: true,
          bmac_confirmed_at: now,
          bmac_member_id: data?.supporter?.id || null,
        });
        console.log('[syncBmacMembers] One-time supporter:', supporterEmail);
      }

    } else if (eventType === 'membership.cancelled') {
      await base44.asServiceRole.entities.User.update(user.id, { bmac_cancelled_at: now });
      const existingSubs = await base44.asServiceRole.entities.Subscription.filter({ user_id: user.id });
      if (existingSubs.length > 0) {
        await base44.asServiceRole.entities.Subscription.update(existingSubs[0].id, { status: 'cancelled' });
      }
      console.log('[syncBmacMembers] Membership cancelled:', supporterEmail);

    } else if (eventType === 'membership.expired') {
      await base44.asServiceRole.entities.User.update(user.id, {
        bmac_payment_confirmed: false,
        bmac_expired_at: now,
      });
      const existingSubs = await base44.asServiceRole.entities.Subscription.filter({ user_id: user.id });
      if (existingSubs.length > 0) {
        await base44.asServiceRole.entities.Subscription.update(existingSubs[0].id, { tier: 'free', status: 'expired' });
      }
      console.log('[syncBmacMembers] Membership expired:', supporterEmail);

    } else {
      console.log('[syncBmacMembers] Unhandled event type:', eventType);
    }

    return Response.json({ received: true });

  } catch (error) {
    console.error('[syncBmacMembers] Error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});