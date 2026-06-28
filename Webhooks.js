const express = require('express');
const router = express.Router();
const {
  leadExists, createLead, updateLeadStatus, logActivity, getAttemptCount, moveToNurture,
  getLead, setLastAnsweredCallAt, getClientSettings, scheduleSms,
  recordBookingEvent, cancelScheduledSmsForLead,
  getSmsTemplate, resolveTemplate,
} = require('../services/leads');
const { triggerRetellCall } = require('../services/retell');
const { sendSMS } = require('../services/twilio');
const { queueDemoWebCall } = require('../services/simulator');
const { computeSmsSendTime } = require('../services/timezone');

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
      await setLastActionSafe(lead.id, 'Call in progress');
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

    // Map Retell outcome to our status.
    //
    // IMPORTANT: this no longer guesses "booked" by string-matching the
    // call summary for the word "booked" — that was fragile (e.g. "asked
    // about booking but didn't book" would have matched). Booking status
    // now comes ONLY from /webhook/booking-event, fired by the n8n
    // workflow at the exact moment book_appointment actually succeeds —
    // that's the one place that genuinely knows. This handler just
    // determines whether the call was answered at all.
    let newStatus = 'attempted';
    let activityOutcome = 'no_answer';
    let notes = '';

    if (callAnalysis) {
      const summary = callAnalysis.call_summary?.toLowerCase() || '';
      const userSentiment = callAnalysis.user_sentiment?.toLowerCase() || '';

      if (summary.includes('not interested') || userSentiment === 'negative') {
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

    // Answered and still open (not dead, not asked to call back later,
    // and crucially not already booked) — schedule the timezone-aware
    // follow-up SMS using the same logic as the demo simulator path.
    if (newStatus === 'contacted') {
      await setLastAnsweredCallAt(leadId, new Date());
      const lead = await getLead(leadId);
      if (lead.status !== 'booked') {
        const { timezone, settings, businessName } = await getClientSettings(lead.client_id);
        const { variant, sendAt } = computeSmsSendTime(new Date(), timezone, settings);
        const slot = variant === 'morning' ? 'followup_morning' : 'followup_evening';
        const template = await getSmsTemplate(lead.client_id, slot);
        const message = resolveTemplate(template, lead, businessName);
        await scheduleSms(leadId, message, variant, sendAt);
      }
    }

    // If no answer and not dead — send SMS as next touch
    if (newStatus === 'attempted') {
      const attemptCount = await getAttemptCount(leadId);

      if (attemptCount <= 3) {
        // Still in hot follow up sequence — send SMS.
        // FIX: this previously called require('../supabase').from(...)
        // without awaiting it, which returns a Promise, not query
        // results — { data: lead } was always destructuring off an
        // unresolved Promise, so `lead` was always undefined and this
        // whole branch silently never sent anything for real calls.
        const lead = await getLead(leadId);

        if (lead) {
          const slot = attemptCount === 1 ? 'no_answer_1' : attemptCount === 2 ? 'no_answer_2' : 'no_answer_final';
          const { businessName } = await getClientSettings(lead.client_id);
          const template = await getSmsTemplate(lead.client_id, slot);
          const message = resolveTemplate(template, lead, businessName);
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

// --------------------------------------------------------
// POST /webhook/booking-event
// Called by the n8n workflow at the moment book_appointment,
// reschedule_appointment, or cancel_appointment actually succeeds.
// This is the ONLY source of truth for booking status — not Retell's
// call summary text, which is fragile to guess from. n8n is the one
// system that genuinely knows when a booking really went through.
//
// Body: { lead_id, event_type: 'booked'|'rescheduled'|'cancelled',
//          appointment_date, notes }
// If lead_id isn't available to n8n, phone can be passed instead and
// matched against the most recent lead with that number.
// --------------------------------------------------------
router.post('/booking-event', async (req, res) => {
  try {
    const { lead_id, phone, event_type, appointment_date, notes } = req.body;

    if (!event_type || !['booked', 'rescheduled', 'cancelled'].includes(event_type)) {
      return res.status(400).json({ error: 'event_type must be booked, rescheduled, or cancelled' });
    }

    let resolvedLeadId = lead_id;
    if (!resolvedLeadId && phone) {
      const supabase = require('../supabase');
      const { data } = await supabase
        .from('ldm_leads')
        .select('id')
        .eq('phone', phone)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      resolvedLeadId = data?.id || null;
    }

    if (!resolvedLeadId) {
      console.warn('booking-event: could not resolve a lead_id from', { lead_id, phone });
      return res.status(400).json({ error: 'Could not resolve lead_id' });
    }

    await recordBookingEvent(resolvedLeadId, event_type, appointment_date, notes);

    if (event_type === 'booked' || event_type === 'rescheduled') {
      await updateLeadStatus(resolvedLeadId, 'booked', {
        last_action: event_type === 'booked' ? 'Booked' : 'Rescheduled',
        booked: true,
        booking_date: appointment_date || null,
      });
      // The whole point of this endpoint — a lead who just booked should
      // never also get a "still want to book?" SMS sitting in the queue.
      await cancelScheduledSmsForLead(resolvedLeadId, `Cancelled — lead ${event_type}`);

    } else if (event_type === 'cancelled') {
      // Cancelled means there's no longer anything on the calendar — put
      // the lead back into an active state rather than leaving it stuck
      // marked "booked" with nothing actually booked.
      await updateLeadStatus(resolvedLeadId, 'contacted', {
        last_action: 'Booking cancelled',
        booked: false,
      });
    }

    return res.status(200).json({ success: true, lead_id: resolvedLeadId });

  } catch (err) {
    console.error('booking-event webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// --------------------------------------------------------
// POST /webhook/retell-call-details
// Receives Retell's call_ended and call_analyzed events.
// Fires for BOTH real outbound calls and demo web calls — separate from
// the /retell handler above, which only drives the no-answer/SMS/nurture
// follow-up logic. This one's only job is capturing what actually
// happened on the call (transcript, summary, sentiment, duration) so the
// dashboard can show real content instead of just an outcome label.
//
// Set this as the Agent-Level Webhook URL in the Retell dashboard:
//   https://<your-railway-url>/webhook/retell-call-details
//
// Note: Retell's recording_url is only valid for 10 minutes after the
// call ends — if recordings need to be kept, they must be downloaded and
// re-hosted within that window. Not done here; out of scope for now.
// --------------------------------------------------------
router.post('/retell-call-details', async (req, res) => {
  try {
    const { event, call } = req.body;

    if (!call || !call.call_id) {
      return res.status(200).json({ received: true }); // nothing usable, ack anyway so Retell doesn't retry
    }

    // The lead_id was passed in as a dynamic variable when the call was
    // created (see services/retell.js and services/simulator.js), so it
    // comes back to us inside the call object.
    const leadId =
      call.retell_llm_dynamic_variables?.lead_id ||
      call.metadata?.lead_id ||
      null;

    if (!leadId) {
      console.warn(`retell-call-details: no lead_id on call ${call.call_id}, skipping`);
      return res.status(200).json({ received: true });
    }

    if (event === 'call_ended') {
      const durationSeconds = call.duration_ms ? Math.round(call.duration_ms / 1000) : null;
      await logActivity(leadId, 'call', 'answered', 'Call ended', {
        retell_call_id: call.call_id,
        transcript: call.transcript || null,
        duration_seconds: durationSeconds,
      });
    }

    if (event === 'call_analyzed') {
      const summary = call.call_analysis?.call_summary || null;
      const sentiment = call.call_analysis?.user_sentiment || null;
      await logActivity(leadId, 'call', 'answered', 'Call analyzed', {
        retell_call_id: call.call_id,
        call_summary: summary,
        sentiment: sentiment,
      });
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('retell-call-details webhook error:', err.message);
    // Still return 200 — Retell retries up to 3 times on non-2xx, and a
    // transient DB error shouldn't cause duplicate retries for something
    // that's only ever logging, not driving status transitions.
    return res.status(200).json({ received: true, error: err.message });
  }
});
