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

function getSMSMessage(lead, attemptNumber) {
  const name = lead.name?.split(' ')[0] || 'there';
  if (attemptNumber === 1) {
    return `Hey ${name}, tried calling you just now about your roofing request. What's the best time for a quick 2 min call?`;
  }
  if (attemptNumber === 2) {
    return `Hey ${name}, still trying to connect about your roofing quote. Still interested? Just reply yes.`;
  }
  return `Hey ${name}, last follow up on your roofing request. Reply here if you're still looking.`;
}

module.exports = { sendSMS, getSMSMessage };
