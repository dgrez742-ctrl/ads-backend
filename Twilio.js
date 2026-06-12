const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Send SMS to a lead
// Returns success/failure so we can log it in Supabase accurately
async function sendSMS(toNumber, message) {
  try {
    const result = await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: toNumber,
    });

    // Check actual delivery status
    const delivered = result.status !== 'failed' && result.status !== 'undelivered';
    console.log(`SMS to ${toNumber} — status: ${result.status}`);

    return {
      success: delivered,
      sid: result.sid,
      status: result.status,
    };

  } catch (err) {
    console.error(`SMS failed to ${toNumber}:`, err.message);
    return { success: false, error: err.message };
  }
}

// SMS templates based on sequence stage
function getSMSMessage(lead, attemptNumber) {
  const name = lead.name?.split(' ')[0] || 'there';

  if (attemptNumber === 1) {
    return `Hey ${name}, tried calling you just now about your roofing request. What's the best time for a quick 2 min call? Reply here or call us back.`;
  }

  if (attemptNumber === 2) {
    return `Hey ${name}, still trying to connect about your roofing quote. Are you still interested? Just reply yes and we'll sort it out.`;
  }

  // Final SMS
  return `Hey ${name}, last follow up on your roofing request. If you're still looking reply here and we'll get someone out to you.`;
}

module.exports = { sendSMS, getSMSMessage };
