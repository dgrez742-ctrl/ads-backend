const twilio = require('twilio');

// Lazy initialize — only create client when actually needed
// This prevents crashing on startup when Twilio env vars aren't set yet
function getClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return null;
  }
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendSMS(toNumber, message) {
  const client = getClient();
  if (!client) {
    console.warn('Twilio not configured — SMS skipped');
    return { success: false, error: 'Twilio not configured' };
  }
  try {
    const result = await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: toNumber,
    });
    return { success: true, sid: result.sid, status: result.status };
  } catch (err) {
    console.error(`SMS failed to ${toNumber}:`, err.message);
    return { success: false, error: err.message };
  }
}

// NOTE: getSMSMessage() and getFollowUpSmsMessage() used to live here as
// hardcoded template strings. They've been replaced by the editable,
// per-client template system in Leads.js (getSmsTemplate +
// resolveTemplate, backed by the ldm_sms_templates table) — every call
// site that used these now reads real, client-editable templates
// instead. Removed here rather than left as dead code.

module.exports = { sendSMS };
