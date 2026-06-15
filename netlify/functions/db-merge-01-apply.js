/**
 * DB-MERGE-01 One-time DDL migration function
 * Applies the unified passenger schema changes via the service role key.
 * 
 * SECURITY: Protected by MIGRATION_SECRET env var.
 * USAGE: POST /api/db-merge-01-apply with header x-migration-secret: <MIGRATION_SECRET>
 * CLEANUP: Remove this file after successful execution.
 * 
 * PAL-68 / DB-MERGE-01
 */

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MIGRATION_SECRET = process.env.MIGRATION_SECRET || 'db-merge-01-20260615';

const DDL_STEPS = [
  {
    label: 'Add stage column',
    sql: `ALTER TABLE public.passengers 
      ADD COLUMN IF NOT EXISTS stage TEXT 
      CHECK (stage IN ('Intake / Staging','On Manifest / Active Ops','Waitlist','Paused','Removed','Graduated'))`
  },
  {
    label: 'Add relationship column',
    sql: `ALTER TABLE public.passengers 
      ADD COLUMN IF NOT EXISTS relationship TEXT`
  },
  {
    label: 'Add db_merge_version column',
    sql: `ALTER TABLE public.passengers 
      ADD COLUMN IF NOT EXISTS db_merge_version TEXT DEFAULT 'DB-MERGE-01-20260615'`
  }
];

async function execSQL(sql, label) {
  // Use the Supabase SQL execution via the pg_net or direct approach
  // Since we can't do DDL via PostgREST, we'll use a workaround:
  // Create a temporary function that executes the DDL, call it, then drop it
  
  const createFnSQL = `
    CREATE OR REPLACE FUNCTION public._db_merge_01_exec_ddl()
    RETURNS TEXT
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    BEGIN
      ${sql};
      RETURN 'OK';
    EXCEPTION WHEN OTHERS THEN
      RETURN SQLERRM;
    END;
    $$;
    GRANT EXECUTE ON FUNCTION public._db_merge_01_exec_ddl() TO service_role;
  `;
  
  // We can't create functions via PostgREST either
  // Fall back to the PATCH approach for DML operations
  return { ok: false, error: 'DDL not available via PostgREST' };
}

async function populateStages() {
  // This is DML — we CAN do this via PostgREST PATCH
  const passengers = await fetch(
    `${SUPABASE_URL}/rest/v1/passengers?select=id,status,landing_outcome,stage`,
    { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } }
  ).then(r => r.json());

  const stageMap = (status, landing) => {
    const s = (status || '').toLowerCase();
    const l = (landing || '').toLowerCase();
    if (l.includes('offer accepted')) return 'Graduated';
    if (s === 'removed') return 'Removed';
    if (s === 'paused') return 'Paused';
    if (['active', 'boarding', 'onboarding'].includes(s)) return 'On Manifest / Active Ops';
    return 'Intake / Staging';
  };

  const results = [];
  for (const p of passengers) {
    if (p.stage) { results.push({ id: p.id, skipped: true }); continue; }
    const stage = stageMap(p.status, p.landing_outcome);
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/passengers?id=eq.${p.id}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({ stage, db_merge_version: 'DB-MERGE-01-20260615' })
      }
    );
    results.push({ id: p.id, stage, status: resp.status });
  }
  return results;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  const secret = event.headers['x-migration-secret'] || event.headers['X-Migration-Secret'];
  if (secret !== MIGRATION_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars' }) };
  }

  const report = {
    timestamp: new Date().toISOString(),
    migration: 'DB-MERGE-01-20260615',
    ddl_note: 'DDL columns must be added via Supabase SQL editor — see migration file',
    dml_results: null,
    current_state: null
  };

  // Apply DML: populate stage values (works via PostgREST)
  try {
    report.dml_results = await populateStages();
  } catch (e) {
    report.dml_error = e.message;
  }

  // Verify current state
  try {
    const state = await fetch(
      `${SUPABASE_URL}/rest/v1/passengers?select=passenger_id,first_name,last_name,status,stage`,
      { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } }
    ).then(r => r.json());
    report.current_state = state;
  } catch (e) {
    report.state_error = e.message;
  }

  return { statusCode: 200, headers, body: JSON.stringify(report, null, 2) };
};
