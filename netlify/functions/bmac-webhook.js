/** @generated from bmac-webhook.ts — do not edit directly */
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// netlify/functions/bmac-webhook.ts
var bmac_webhook_exports = {};
__export(bmac_webhook_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(bmac_webhook_exports);
var import_node_crypto = require("node:crypto");
var EVENTS = /* @__PURE__ */ new Set(["supporter.created", "membership.started", "membership.updated"]);
var HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bmac-signature",
  "Content-Type": "application/json"
};
function jsonResponse(statusCode, payload) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(payload) };
}
function header(event, name) {
  const headers = event.headers || {};
  return String(headers[name] || headers[name.toLowerCase()] || "").trim();
}
function resolveBase44ApiKey() {
  const direct = process.env.BASE44APIKEY || process.env.BASE44_API_KEY || "";
  if (direct) return direct;
  const raw = process.env.BASE44_AUTH_JSON;
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.apiKey || parsed.api_key || "").trim();
  } catch {
    return "";
  }
}
function base44Headers() {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  const apiKey = resolveBase44ApiKey();
  if (apiKey) headers.api_key = apiKey;
  return headers;
}
function entityUrl(entityName) {
  const appId = String(process.env.BASE44_APP_ID || "").trim();
  if (!appId) throw new Error("BASE44_APP_ID is not configured");
  return `https://app.base44.com/api/apps/${appId}/entities/${entityName}`;
}
function pickArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.results)) return obj.results;
  }
  return [];
}
function normalizeBmacPayload(payload) {
  const data = payload.data ?? {};
  const supporter = data.supporter ?? {};
  const email = String(
    payload.supporter_email ?? supporter.email ?? data.email ?? ""
  ).trim().toLowerCase();
  const eventType = String(payload.type ?? payload.event_type ?? data.type ?? "").trim().toLowerCase();
  const eventId = String(
    payload.id ?? payload.event_id ?? payload.eventId ?? data.id ?? data.event_id ?? ""
  ).trim();
  return { email, eventType, eventId, data };
}
function verifyHmacSha256(rawBody, event) {
  const secret = String(process.env.BMAC_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return { ok: false, response: jsonResponse(500, { error: "server_misconfigured", detail: "BMAC_WEBHOOK_SECRET is required" }) };
  }
  const signatureHeader = header(event, "x-bmac-signature");
  if (!signatureHeader) {
    return { ok: false, response: jsonResponse(401, { error: "missing_identity", detail: "x-bmac-signature is required" }) };
  }
  const [algorithm, receivedHex] = signatureHeader.split("=");
  if (algorithm !== "sha256" || !receivedHex) {
    return { ok: false, response: jsonResponse(403, { error: "insufficient_role", detail: "x-bmac-signature format is invalid" }) };
  }
  const computedHex = (0, import_node_crypto.createHmac)("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(computedHex, "utf8");
  const b = Buffer.from(receivedHex, "utf8");
  if (a.length !== b.length || !(0, import_node_crypto.timingSafeEqual)(a, b)) {
    return { ok: false, response: jsonResponse(403, { error: "insufficient_role", detail: "x-bmac-signature is invalid" }) };
  }
  return { ok: true };
}
async function filterEntity(entityName, filter) {
  const url = new URL(entityUrl(entityName));
  for (const [key, value] of Object.entries(filter)) {
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url.toString(), { method: "GET", headers: base44Headers() });
  if (!res.ok) throw new Error(`Base44 filter ${entityName} failed: ${res.status}`);
  return pickArray(await res.json());
}
async function createEntity(entityName, fields) {
  const res = await fetch(entityUrl(entityName), {
    method: "POST",
    headers: base44Headers(),
    body: JSON.stringify(fields)
  });
  if (!res.ok) throw new Error(`Base44 create ${entityName} failed: ${res.status}`);
  return await res.json();
}
async function updateEntity(entityName, id, fields, existing) {
  const res = await fetch(`${entityUrl(entityName)}/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: base44Headers(),
    body: JSON.stringify({ ...existing || {}, ...fields })
  });
  if (!res.ok) throw new Error(`Base44 update ${entityName} failed: ${res.status}`);
  return res.json();
}
async function claimBmacEvent(eventId, handler2, payload) {
  if (!eventId) throw new Error("Missing BMAC event ID");
  try {
    const row = await createEntity("BmacWebhookEvent", {
      event_id: eventId,
      handler: handler2,
      status: "processing",
      payload,
      claimed_at: (/* @__PURE__ */ new Date()).toISOString()
    });
    return { claimed: true, row };
  } catch (error) {
    const rows = await filterEntity("BmacWebhookEvent", {
      event_id: eventId,
      handler: handler2
    });
    const existing = rows[0];
    if (existing?.status === "completed") return { claimed: false, duplicate: true, row: existing };
    if (existing?.status === "processing") return { claimed: false, inFlight: true, row: existing };
    if (existing?.id) {
      await updateEntity("BmacWebhookEvent", String(existing.id), {
        status: "processing",
        claimed_at: (/* @__PURE__ */ new Date()).toISOString(),
        last_error: null
      }, existing);
      return { claimed: true, row: existing };
    }
    throw error;
  }
}
async function completeBmacEvent(row, result) {
  await updateEntity("BmacWebhookEvent", String(row.id), {
    status: "completed",
    completed_at: (/* @__PURE__ */ new Date()).toISOString(),
    result: result ?? null
  }, row);
}
async function failBmacEvent(row, error) {
  await updateEntity("BmacWebhookEvent", String(row.id), {
    status: "failed",
    failed_at: (/* @__PURE__ */ new Date()).toISOString(),
    last_error: error instanceof Error ? error.message : String(error)
  }, row);
}
async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }
  let row;
  try {
    const raw = event.body || "";
    const guard = verifyHmacSha256(raw, event);
    if (!guard.ok) return guard.response;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return jsonResponse(400, { error: "Invalid JSON payload" });
    }
    const normalized = normalizeBmacPayload(payload);
    if (!normalized.eventId) return jsonResponse(400, { error: "Missing event ID" });
    const claim = await claimBmacEvent(normalized.eventId, "bmac-webhook", payload);
    if (!claim.claimed) {
      return jsonResponse(200, {
        received: true,
        action: claim.duplicate ? "duplicate" : "in_flight",
        eventId: normalized.eventId
      });
    }
    row = claim.row;
    if (!normalized.email) {
      await completeBmacEvent(row, { action: "no_email" });
      return jsonResponse(200, { received: true, action: "no_email" });
    }
    if (!EVENTS.has(normalized.eventType)) {
      await completeBmacEvent(row, { action: "ignored", eventType: normalized.eventType });
      return jsonResponse(200, { received: true, action: "ignored", eventType: normalized.eventType });
    }
    const users = await filterEntity("User", { email: normalized.email });
    if (!users.length) {
      await completeBmacEvent(row, { action: "no_user_found" });
      return jsonResponse(200, { received: true, action: "no_user_found" });
    }
    const user = users[0];
    if (user.is_sponsored === true) {
      await completeBmacEvent(row, { action: "sponsored_bypass" });
      return jsonResponse(200, { received: true, action: "sponsored_bypass" });
    }
    const flights = await filterEntity("PassengerFlight", {
      passenger_id: user.id,
      bmac_payment_confirmed: false
    });
    const flight = flights.sort(
      (a, b) => new Date(String(b.joined_at || 0)).getTime() - new Date(String(a.joined_at || 0)).getTime()
    )[0];
    if (!flight) {
      await completeBmacEvent(row, { action: "no_flight_row" });
      return jsonResponse(200, { received: true, action: "no_flight_row" });
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (!flight.cabin) {
      await updateEntity("PassengerFlight", String(flight.id), { bmac_payment_needs_review: true }, flight);
      await completeBmacEvent(row, { action: "needs_review" });
      return jsonResponse(200, { received: true, action: "needs_review" });
    }
    const tier = flight.cabin === "First" ? "pro" : flight.cabin === "Business" ? "plus" : "free";
    await updateEntity("User", String(user.id), { cabin_class: flight.cabin }, user);
    await updateEntity(
      "PassengerFlight",
      String(flight.id),
      { bmac_payment_confirmed: true, bmac_payment_confirmed_at: now },
      flight
    );
    const subscriptions = await filterEntity("Subscription", {
      user_id: user.id
    });
    if (subscriptions.length) {
      await updateEntity(
        "Subscription",
        String(subscriptions[0].id),
        { tier, status: "active" },
        subscriptions[0]
      );
    } else {
      await createEntity("Subscription", { user_id: user.id, tier, status: "active" });
    }
    await completeBmacEvent(row, { action: "payment_confirmed", userId: user.id, tier });
    return jsonResponse(200, {
      received: true,
      action: "payment_confirmed",
      userId: user.id,
      tier
    });
  } catch (error) {
    if (row) {
      try {
        await failBmacEvent(row, error);
      } catch {
      }
    }
    console.error("[bmac-webhook]", error);
    return jsonResponse(500, { error: "Webhook processing failed" });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
