const axios = require('axios');

// Retell account rotation
// Cycles through available accounts when one runs out of credits
const retellAccounts = [
  { apiKey: process.env.RETELL_API_KEY_1, agentId: process.env.RETELL_AGENT_ID_1 },
  { apiKey: process.env.RETELL_API_KEY_2, agentId: process.env.RETELL_AGENT_ID_2 },
  { apiKey: process.env.RETELL_API_KEY_3, agentId: process.env.RETELL_AGENT_ID_3 },
].filter(a => a.apiKey && a.agentId); // only use accounts that are configured

let currentAccountIndex = 0;

function getRetellAccount() {
  return retellAccounts[currentAccountIndex % retellAccounts.length];
}

function rotateRetellAccount() {
  currentAccountIndex = (currentAccountIndex + 1) % retellAccounts.length;
  console.log(`Rotated to Retell account ${currentAccountIndex + 1}`);
}

// Trigger an outbound call via Retell
// Passes full lead context so the agent knows exactly what to say
async function triggerRetellCall(lead, attemptNumber) {
  // Guard: no Retell accounts configured at all (missing env vars in
  // Railway/Render). Without this, getRetellAccount() returns undefined
  // and the line below throws "Cannot read properties of undefined
  // (reading 'agentId')" instead of a clear, actionable error.
  if (retellAccounts.length === 0) {
    const msg = 'No Retell accounts configured — set RETELL_API_KEY_1 and RETELL_AGENT_ID_1 (at minimum) in your environment variables.';
    console.error(msg);
    return { success: false, error: msg };
  }

  const account = getRetellAccount();

  // Build context that Retell agent uses to personalize the call
  const callContext = {
    lead_name: lead.name,
    offer_seen: lead.offer_seen || 'roofing services',
    attempt_number: attemptNumber,
    is_first_call: attemptNumber === 1,
    is_followup: attemptNumber > 1,
    is_nurture: lead.status === 'nurture',
    client_id: lead.client_id,
  };

  try {
    const response = await axios.post(
      'https://api.retellai.com/v2/create-phone-call',
      {
        from_number: process.env.TWILIO_PHONE_NUMBER,
        to_number: lead.phone,
        agent_id: account.agentId,
        retell_llm_dynamic_variables: callContext,
      },
      {
        headers: {
          Authorization: `Bearer ${account.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`Call triggered for lead ${lead.id} — attempt ${attemptNumber}`);
    return { success: true, callId: response.data.call_id };

  } catch (err) {
    const status = err.response?.status;

    // If insufficient credits — rotate to next account and retry once
    if (status === 402 || status === 429) {
      console.warn(`Retell account ${currentAccountIndex + 1} out of credits. Rotating...`);
      rotateRetellAccount();

      const newAccount = getRetellAccount();
      try {
        const retryResponse = await axios.post(
          'https://api.retellai.com/v2/create-phone-call',
          {
            from_number: process.env.TWILIO_PHONE_NUMBER,
            to_number: lead.phone,
            agent_id: newAccount.agentId,
            retell_llm_dynamic_variables: callContext,
          },
          {
            headers: {
              Authorization: `Bearer ${newAccount.apiKey}`,
              'Content-Type': 'application/json',
            },
          }
        );
        return { success: true, callId: retryResponse.data.call_id };
      } catch (retryErr) {
        console.error('All Retell accounts failed:', retryErr.message);
        return { success: false, error: 'All Retell accounts exhausted' };
      }
    }

    console.error(`Retell call failed for lead ${lead.id}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { triggerRetellCall };
