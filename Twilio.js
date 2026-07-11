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

  // TESTING OVERRIDE: while SMS_OVERRIDE_NUMBER is set (e.g. in Railway),
  // every real Twilio send goes to that number instead of the lead's
  // actual phone number. Lead records and the front end are unaffected —
  // this only changes the destination at the point of dispatch.
  // Remove the SMS_OVERRIDE_NUMBER env var to go live and fall back to
  // real lead numbers automatically — no code change needed.
  const destination = process.env.SMS_OVERRIDE_NUMBER || toNumber;

  try {
    const result = await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: destination,
    });
    return { success: true, sid: result.sid, status: result.status };
  } catch (err) {
    console.error(`SMS failed to ${destination}:`, err.message);
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
