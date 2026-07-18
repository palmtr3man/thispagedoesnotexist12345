import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { firstRequiredEnv } from './shared/config.ts';
import { ENV_ALIASES } from './shared/platformSecrets.ts';

const PIPELINE_DB_ID = firstRequiredEnv(...ENV_ALIASES.notionPassengerPipelineDbId);

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }

    const { accessToken } = await base44.asServiceRole.connectors.getConnection('notion');

    // Paginate through all results
    let allResults = [];
    let cursor = undefined;
    do {
      const body = cursor ? { start_cursor: cursor } : {};
      const res = await fetch(`https://api.notion.com/v1/databases/${PIPELINE_DB_ID}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        return Response.json({ error: data.message || 'Notion API error' }, { status: 500 });
      }
      allResults = allResults.concat(data.results || []);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    console.log(`Fetched ${allResults.length} rows from Notion pipeline`);

    const created = [];
    const updated = [];
    const skipped = [];

    for (const page of allResults) {
      const p = page.properties;

      // Extract name — try common property names
      const name =
        p['Name']?.title?.[0]?.plain_text ||
        p['Full Name']?.title?.[0]?.plain_text ||
        p['Contact']?.title?.[0]?.plain_text ||
        '';

      if (!name) {
        skipped.push(page.id);
        continue;
      }

      // Extract fields — MUST happen before preflight which references email
      const email =
        p['Email']?.email ||
        p['email']?.email ||
        p['Email Address']?.email ||
        p['Email']?.rich_text?.[0]?.plain_text || '';

      const company =
        p['Company']?.rich_text?.[0]?.plain_text ||
        p['Organization']?.rich_text?.[0]?.plain_text ||
        p['Company']?.select?.name || '';

      const status =
        p['Status']?.select?.name ||
        p['Journey Status']?.select?.name ||
        p['Stage']?.select?.name || '';

      const tier =
        p['Tier']?.select?.name?.toLowerCase() ||
        p['Plan']?.select?.name?.toLowerCase() || 'free';

      const notes =
        p['Notes']?.rich_text?.[0]?.plain_text ||
        p['Note']?.rich_text?.[0]?.plain_text || '';

      const linkedin =
        p['LinkedIn']?.url ||
        p['LinkedIn URL']?.url || '';

      // Map Notion status → canonical intake_status (journey_status is deprecated — never written)
      // notion_owned: name, email, company, linkedin, notes, notion_page_id, notion_synced_at
      // base44_owned: tier, intake_status, boarding_readiness_status, seat_id, active_flight_id
      // derived:      intake_complete, first_name
      const statusLower = status.toLowerCase();
      // Only set intake_status on CREATE (new records). Never overwrite on existing records
      // — intake_status is base44_owned and the canonical lifecycle source of truth.
      let derivedIntakeStatus = null;
      if (statusLower.includes('active') || statusLower.includes('boarded')) derivedIntakeStatus = 'boarded';
      else if (statusLower.includes('grad')) derivedIntakeStatus = 'archived';
      else if (statusLower.includes('board')) derivedIntakeStatus = 'invited';
      else if (statusLower.includes('offer')) derivedIntakeStatus = 'reviewed';
      // else: new record gets default 'not_invited' from entity schema

      // Check for existing passenger by notion_page_id or email
      let existing = null;
      const byNotionId = await base44.asServiceRole.entities.Passenger.filter({ notion_page_id: page.id });
      if (byNotionId.length > 0) {
        existing = byNotionId[0];
      } else if (email) {
        const byEmail = await base44.asServiceRole.entities.Passenger.filter({ email });
        if (byEmail.length > 0) existing = byEmail[0];
      }

      // notion_owned fields only — never touch tier, intake_status, seat_id, active_flight_id
      const notionOwnedPayload = {
        name,
        email: email || undefined,
        company: company || undefined,   // Never write "Unknown" — only write if we have a real value
        linkedin: linkedin || undefined,
        notes: notes || undefined,
        notion_page_id: page.id,
        notion_synced_at: new Date().toISOString(),
        // journey_status intentionally NOT written — deprecated field, base44_owned lifecycle only
      };

      if (existing) {
        // UPDATE: only notion_owned fields. Never overwrite base44_owned fields.
        await base44.asServiceRole.entities.Passenger.update(existing.id, notionOwnedPayload);
        updated.push(name);
      } else {
        // CREATE: seed intake_status from Notion stage signal (one-time only)
        await base44.asServiceRole.entities.Passenger.create({
          ...notionOwnedPayload,
          status: 'active',
          intake_status: derivedIntakeStatus || 'not_invited',
          waitlist_joined_at: page.created_time || new Date().toISOString(),
        });
        created.push(name);
      }
    }

    return Response.json({
      ok: true,
      total: allResults.length,
      created: created.length,
      updated: updated.length,
      skipped: skipped.length,
      created_names: created,
      updated_names: updated,
    });

  } catch (err) {
    console.error('syncPassengerPipeline error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
});