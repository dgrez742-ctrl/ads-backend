const axios = require('axios');

// --------------------------------------------------------
// DEMO / SIMULATOR SERVICE
// Fully separate from the real outbound calling flow (services/retell.js).
// This NEVER dials a real phone number — it only opens a Retell WEB CALL
// (WebRTC, browser-based) using the same agent configured for production
// (RETELL_AGENT_ID_1 / RETELL_API_KEY_1), purely for demo purposes.
// --------------------------------------------------------

const DEMO_RING_DELAY_MS = 10 * 1000; // fixed 10s between lead injection and ring

// In-memory queue — single demo session at a time is enough for live demos.
// Not persisted; resets if the server restarts. That's intentional — this is
// demo-only state, not real lead data (real lead data still lives in Supabase).
let pendingCall = null;   // { lead, access_token, call_id, queued_at }
let activeCall = null;    // the call currently answered/in-progress (for logging only)

// --------------------------------------------------------
// Queue a demo call — called by /webhook/meta when demo:true
// Waits DEMO_RING_DELAY_MS, then creates a Retell web call and
// makes it available to the simulator via getPendingCall().
// --------------------------------------------------------
function queueDemoWebCall(lead) {
  console.log(`Demo call queued for lead ${lead.id} — ringing in ${DEMO_RING_DELAY_MS / 1000}s`);

  setTimeout(async () => {
    try {
      const webCall = await createRetellWebCall(lead);
      pendingCall = {
        lead: {
          id: lead.id,
          name: lead.name,
          phone: lead.phone,
          offer_seen: lead.offer_seen,
        },
        access_token: webCall.access_token,
        call_id: webCall.call_id,
        queued_at: new Date().toISOString(),
      };
      console.log(`Demo web call ready for lead ${lead.id} — call_id ${webCall.call_id}`);
    } catch (err) {
      // axios hides the real reason behind a generic "Request failed with
      // status code 400" message — log the actual response body from
      // Retell so we can see the real validation error instead of guessing.
      if (err.response) {
        console.error(
          `Failed to create demo web call for lead ${lead.id} — Retell responded ${err.response.status}:`,
          JSON.stringify(err.response.data)
        );
      } else {
        console.error(`Failed to create demo web call for lead ${lead.id}:`, err.message);
      }
    }
  }, DEMO_RING_DELAY_MS);
}

// --------------------------------------------------------
// Create a Retell WEB CALL (not a phone call).
// Uses RETELL_API_KEY_1 / RETELL_AGENT_ID_1 — the same account used by the
// first production rotation slot. No from_number / to_number involved;
// nothing here can ever dial a real phone.
//
// IMPORTANT: every value in retell_llm_dynamic_variables MUST be a string —
// Retell's API returns 400 Bad Request if any value is a boolean, number,
// or other type. Compute date helpers as plain strings too.
// --------------------------------------------------------
async function createRetellWebCall(lead) {
  const apiKey = process.env.RETELL_API_KEY_1;
  const agentId = process.env.RETELL_AGENT_ID_1;

  if (!apiKey || !agentId) {
    throw new Error('RETELL_API_KEY_1 / RETELL_AGENT_ID_1 not configured — demo web call unavailable');
  }

  const response = await axios.post(
    'https://api.retellai.com/v2/create-web-call',
    {
      agent_id: agentId,
      retell_llm_dynamic_variables: buildReceptionistVariables(lead),
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return {
    access_token: response.data.access_token,
    call_id: response.data.call_id,
  };
}

// --------------------------------------------------------
// Builds every {{variable}} the receptionist prompt references.
// All values are strings, per Retell's requirement.
// Business-identity fields are read from env vars so they can be changed
// per-demo without touching code — set sensible defaults via env vars in
// Railway (see DEMO_BUSINESS_* below), or fall back to generic values.
// --------------------------------------------------------
function buildReceptionistVariables(lead) {
  const fmt = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD
  const today = new Date();

  const nextWeekday = (targetDay) => {
    const d = new Date(today);
    const diff = (targetDay - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return fmt(d);
  };

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return {
    agent_name: process.env.DEMO_AGENT_NAME || 'Ava',
    business_name: process.env.DEMO_BUSINESS_NAME || 'BotCipher Home Services',
    industry: process.env.DEMO_INDUSTRY || 'home services',
    business_phone: process.env.DEMO_BUSINESS_PHONE || '+1 (555) 010-0000',
    business_email: process.env.DEMO_BUSINESS_EMAIL || 'hello@botcipher.demo',
    working_hours: process.env.DEMO_WORKING_HOURS || '8 AM to 6 PM',
    working_days: process.env.DEMO_WORKING_DAYS || 'Monday through Saturday',
    emergency_keywords: process.env.DEMO_EMERGENCY_KEYWORDS || 'flood, leak, no heat, gas smell, burst pipe',
    emergency_callback_minutes: process.env.DEMO_EMERGENCY_CALLBACK_MINUTES || '15',
    tenant_id: process.env.DEMO_TENANT_ID || 'demo-tenant',

    current_date: today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    day_of_week: today.toLocaleDateString('en-US', { weekday: 'long' }),
    current_date_iso: fmt(today),
    tomorrow_iso: fmt(tomorrow),
    next_monday: nextWeekday(1),
    next_tuesday: nextWeekday(2),
    next_wednesday: nextWeekday(3),
    next_thursday: nextWeekday(4),
    next_friday: nextWeekday(5),
    next_saturday: nextWeekday(6),
    next_sunday: nextWeekday(0),

    // Lead/demo context — declared in the prompt's "Demo Caller Context"
    // section so the agent actually uses them, rather than sending
    // variables the prompt never references.
    lead_name: lead.name || 'there',
    offer_seen: lead.offer_seen || 'our services',
  };
}

// --------------------------------------------------------
// Called by the simulator's poll loop. Returns the pending call (if its
// web-call session is ready) and clears it from the queue so it's only
// handed out once.
// --------------------------------------------------------
function takePendingCall() {
  if (!pendingCall) return null;
  const call = pendingCall;
  pendingCall = null;
  activeCall = call;
  return call;
}

function getActiveLeadId() {
  return activeCall ? activeCall.lead.id : null;
}

function clearActiveCall() {
  activeCall = null;
}

module.exports = {
  queueDemoWebCall,
  takePendingCall,
  getActiveLeadId,
  clearActiveCall,
  DEMO_RING_DELAY_MS,
};
