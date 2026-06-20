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
      console.error(`Failed to create demo web call for lead ${lead.id}:`, err.message);
    }
  }, DEMO_RING_DELAY_MS);
}

// --------------------------------------------------------
// Create a Retell WEB CALL (not a phone call).
// Uses RETELL_API_KEY_1 / RETELL_AGENT_ID_1 — the same account used by the
// first production rotation slot. No from_number / to_number involved;
// nothing here can ever dial a real phone.
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
      retell_llm_dynamic_variables: {
        lead_name: lead.name,
        offer_seen: lead.offer_seen || 'roofing services',
        is_demo: true,
      },
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
