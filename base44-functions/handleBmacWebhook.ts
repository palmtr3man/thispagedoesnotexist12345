import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { auditInvocation, verifyHmacSha256 } from './shared/invocationGuard.ts';
import { requirePost, normalizeBmacPayload, claimBmacEvent, completeBmacEvent, failBmacEvent } from './shared/bmacWebhook.ts';
const EVENTS = new Set(['supporter.created','membership.started','membership.updated']);
Deno.serve(async (req) => {
  const method = requirePost(req); if (method) return method;
  let row: any;
  try {
    const raw = await req.text();
    const guard = await verifyHmacSha256(raw, req, { secretEnv:'BMAC_WEBHOOK_SECRET', signatureHeader:'x-bmac-signature', prefix:'sha256' });
    if (!guard.ok) return guard.response; auditInvocation('handleBmacWebhook', guard);
    let payload: any; try { payload = JSON.parse(raw); } catch { return Response.json({error:'Invalid JSON payload'},{status:400}); }
    const b = normalizeBmacPayload(payload); if (!b.eventId) return Response.json({error:'Missing event ID'},{status:400});
    const base44 = createClientFromRequest(req); const claim = await claimBmacEvent(base44,b.eventId,'handleBmacWebhook',payload);
    if (!claim.claimed) return Response.json({received:true,action:claim.duplicate?'duplicate':'in_flight',eventId:b.eventId}); row = claim.row;
    if (!b.email) { await completeBmacEvent(base44,row,{action:'no_email'}); return Response.json({received:true,action:'no_email'}); }
    if (!EVENTS.has(b.eventType)) { await completeBmacEvent(base44,row,{action:'ignored'}); return Response.json({received:true,action:'ignored',eventType:b.eventType}); }
    const users = await base44.asServiceRole.entities.User.filter({email:b.email}); if (!users?.length) { await completeBmacEvent(base44,row,{action:'no_user_found'}); return Response.json({received:true,action:'no_user_found'}); }
    const user=users[0]; if (user.is_sponsored===true) { await completeBmacEvent(base44,row,{action:'sponsored_bypass'}); return Response.json({received:true,action:'sponsored_bypass'}); }
    const flights=await base44.asServiceRole.entities.PassengerFlight.filter({passenger_id:user.id,bmac_payment_confirmed:false}); const flight=flights?.sort((a:any,c:any)=>new Date(c.joined_at||0).getTime()-new Date(a.joined_at||0).getTime())[0];
    if (!flight) { await completeBmacEvent(base44,row,{action:'no_flight_row'}); return Response.json({received:true,action:'no_flight_row'}); }
    const now=new Date().toISOString(); if (!flight.cabin) { await base44.asServiceRole.entities.PassengerFlight.update(flight.id,{bmac_payment_needs_review:true}); await completeBmacEvent(base44,row,{action:'needs_review'}); return Response.json({received:true,action:'needs_review'}); }
    const tier=flight.cabin==='First'?'pro':flight.cabin==='Business'?'plus':'free'; await base44.asServiceRole.entities.User.update(user.id,{cabin_class:flight.cabin}); await base44.asServiceRole.entities.PassengerFlight.update(flight.id,{bmac_payment_confirmed:true,bmac_payment_confirmed_at:now}); const subs=await base44.asServiceRole.entities.Subscription.filter({user_id:user.id}); if(subs?.length) await base44.asServiceRole.entities.Subscription.update(subs[0].id,{tier,status:'active'}); else await base44.asServiceRole.entities.Subscription.create({user_id:user.id,tier,status:'active'});
    await completeBmacEvent(base44,row,{action:'payment_confirmed',userId:user.id}); return Response.json({received:true,action:'payment_confirmed',userId:user.id,tier});
  } catch(e) { if(row) { try { const b=createClientFromRequest(req); await failBmacEvent(b,row,e); } catch(_) {} } console.error(e); return Response.json({error:'Webhook processing failed'},{status:500}); }
});