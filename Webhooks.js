const express = require('express');
const router = express.Router();
const { leadExists, createLead, updateLeadStatus, logActivity, getAttemptCount, moveToNurture } = require('../services/leads');
const { triggerRetellCall } = require('../services/retell');
const { sendSMS, getSMSMessage } = require('../services/twilio');
const { queueDemoWebCall } = require('../services/simulator');

// --------------------------------------------------------
// POST /webhook/meta
// Receives lead data from Meta via n8n or direct webhook.
//
// DEMO MODE: if body.demo === true (e.g. from the dashboard's "Inject Lead"
// button), this NEVER dials a real phone. Instead it queues a Retell WEB
// CALL for the phone simulator, on a fixed delay. Real Meta leads never
// set this flag, so production behavior is unchanged.
// --------------------------------------------------------
router.post('/meta', async (req, res) => {
  try {
    const body = req.body;
    console.log('Meta webhook received:', JSON.stringify(body));

    // Extract lead fields — Meta sends these from the lead form
    const isDemo = body.demo === true;

    const leadData = {
      client_id: body.client_id,         // passed by n8n based on which client's form
      campaign_id: body.campaign_id || null,
      name: body.full_name || body.name,
      phone: body.phone_number || body.phone,
      email: body.email,
      offer_seen: body.ad_name || body.offer_seen || null,
      is_demo: isDemo,
    };

    // Validate we have minimum required fields
    if (!leadData.client_id || !leadData.phone) {
      console.warn('Missing required fields — client_id or phone');
      return res.status(400).json({ error: 'Missing client_id or phone' });
    }

    // DEDUPLICATION — don't process same phone number twice for same client
    const exists = await leadExists(leadData.client_id, leadData.phone);
    if (exists) {
      console.log(`Duplicate lead ignored — ${leadData.phone} already exists for client ${leadData.client_id}`);
      return res.status(200).json({ message: 'Duplicate lead ignored' });
    }

    // Store lead in Supabase
    const lead = await createLead(leadData);
    console.log(`Lead created: ${lead.id}`);

    if (isDemo) {
      // DEMO PATH — queue a web call for the simulator. No real phone call.
      queueDemoWebCall(lead);
      await setLastActionSafe(lead.id, 'Demo call queued');
      return res.status(200).json({ success: true, leadId: lead.id, demo: true });
    }

    // PRODUCTION PATH — trigger the real outbound phone call immediately
    const callResult = await triggerRetellCall(lead, 1);

    if (callResult.success) {
      // Update status to attempted and log the call
      await updateLeadStatus(lead.id, 'attempted');
      await logActivity(lead.id, 'call', 'no_answer', 'Initial call triggered');
    } else {
      // Call failed to trigger — log it and flag for manual review
      await logActivity(lead.id, 'call', 'no_answer', `Call trigger failed: ${callResult.error}`);
      console.error(`Failed to trigger call for lead ${lead.id}`);
    }

    return res.status(200).json({ success: true, leadId: lead.id });

  } catch (err) {
    console.error('Meta webhook error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Small helper so a logging failure never breaks the demo-injection response
async function setLastActionSafe(leadId, text) {
  try {
    const { setLastAction } = require('../services/leads');
    await setLastAction(leadId, text);
  } catch (err) {
    console.warn('setLastAction failed (non-fatal):', err.message);
  }
}

// --------------------------------------------------------
// POST /webhook/retell
// Receives call outcome from Retell after every call ends
// --------------------------------------------------------
router.post('/retell', async (req, res) => {
  try {
    const body = req.body;
    console.log('Retell webhook received:', JSON.stringify(body));

    const leadId = body.retell_llm_dynamic_variables?.lead_id || body.lead_id;
    const callStatus = body.call_status;         // 'ended', 'error'
    const callAnalysis = body.call_analysis;     // Retell's outcome summary
    const disconnectionReason = body.disconnection_reason;

    if (!leadId) {
      console.warn('No lead_id in Retell webhook');
      return res.status(400).json({ error: 'Missing lead_id' });
    }

    // Map Retell outcome to our status
    let newStatus = 'attempted';
    let activityOutcome = 'no_answer';
    let notes = '';

    if (callAnalysis) {
      const summary = callAnalysis.call_summary?.toLowerCase() || '';
      const userSentiment = callAnalysis.user_sentiment?.toLowerCase() || '';

      if (summary.includes('booked') || summary.includes('appointment')) {
        newStatus = 'booked';
        activityOutcome = 'answered';
        notes = 'Booked via Retell';

      } else if (summary.includes('not interested') || userSentiment === 'negative') {
        newStatus = 'dead';
        activityOutcome = 'answered';
        notes = 'Not interested';

      } else if (summary.includes('call back') || summary.includes('later')) {
        newStatus = 'attempted';
        activityOutcome = 'answered';
        notes = 'Asked to call back later';

      } else if (callStatus === 'ended' && disconnectionReason !== 'voicemail') {
        newStatus = 'contacted';
        activityOutcome = 'answered';
        notes = callAnalysis.call_summary || 'Call completed';
      }
    }

    // Voicemail left
    if (disconnectionReason === 'voicemail') {
      activityOutcome = 'voicemail';
      notes = 'Voicemail left';
    }

    // Update lead status
    await updateLeadStatus(leadId, newStatus);
    await logActivity(leadId, 'call', activityOutcome, notes);

    // If no answer and not dead — send SMS as next touch
    if (newStatus === 'attempted') {
      const attemptCount = await getAttemptCount(leadId);

      if (attemptCount <= 3) {
        // Still in hot follow up sequence — send SMS
        // Get lead data for SMS
        const { data: lead } = require('../supabase')
          .from('ldm_leads')
          .select('*')
          .eq('id', leadId)
          .single();

        if (lead) {
          const message = getSMSMessage(lead, attemptCount);
          const smsResult = await sendSMS(lead.phone, message);
          await logActivity(leadId, 'sms', smsResult.success ? 'sent' : 'bounced', message);
        }

      } else {
        // Exhausted hot sequence — move to nurture
        await moveToNurture(leadId);
        console.log(`Lead ${leadId} moved to nurture sequence`);
      }
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Retell webhook error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
