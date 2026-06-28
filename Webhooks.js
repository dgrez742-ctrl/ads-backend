const express = require('express');
const router = express.Router();
const {
  leadExists, createLead, updateLeadStatus, logActivity, getAttemptCount, moveToNurture,
  getLead, setLastAnsweredCallAt, getClientSettings, scheduleSms,
  recordBookingEvent, cancelScheduledSmsForLead,
  getSmsTemplate, resolveTemplate,
  getCallByRetellId, saveCall, updateCallByRetellId,
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

    // FIX: Retell's actual webhook payload shape is { event, call: {...} }
    // — call_status, call_analysis, disconnection_reason, and the
    // dynamic variables all live INSIDE call, not at the root of body.
    // This previously read body.call_status / body.call_analysis
    // directly, which would be undefined on every real Retell delivery
    // matching their documented shape — meaning this handler's outcome
    // classification logic below may have been silently running on
    // undefined the whole time, always falling through to the
    // 'attempted'/'no_answer' default. Reading from `call` first (with
    // a fallback to root, in case this endpoint really is wired to
    // something that sends a flat shape) fixes that without assuming
    // away the possibility that the flat shape was intentional.
    const call = body.call || {};
    let leadId =
      call.retell_llm_dynamic_variables?.lead_id ||
      body.retell_llm_dynamic_variables?.lead_id ||
      body.lead_id ||
      null;
    const callStatus = call.call_status || body.call_status;
    const callAnalysis = call.call_analysis || body.call_analysis;
    const disconnectionReason = call.disconnection_reason || body.disconnection_reason;
    const retellCallId = call.call_id || body.call_id || null;

    // FALLBACK: lead_id should always be present now that it's sent as
    // a dynamic variable on every outbound call (see services/retell.js
    // and services/simulator.js), but if Retell's dynamic-variable echo
    // ever fails to come through for any reason, fall back to matching
    // the caller's phone number against the most recent lead with that
    // number — same pattern already used in /webhook/booking-event and
    // /webhook/retell-call-details, so all three handlers degrade the
    // same way instead of just 400-ing and losing the event entirely.
    if (!leadId) {
      const callerPhone = call.from_number || call.to_number || body.from_number || body.to_number || null;
      if (callerPhone) {
        const supabase = require('../supabase');
        const { data } = await supabase
          .from('ldm_leads')
          .select('id')
          .eq('phone', callerPhone)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        leadId = data?.id || null;
        if (leadId) {
          console.log(`[webhook/retell] Resolved lead ${leadId} via phone fallback (no lead_id on call)`);
        }
      }
    }

    if (!leadId) {
      console.warn('No lead_id in Retell webhook (and no phone match)');
      return res.status(400).json({ error: 'Missing lead_id' });
    }

    // DEDUP: Retell retries webhook deliveries up to 3 times if it
    // doesn't get a 2xx response within 10 seconds. Without this check,
    // a retried delivery would re-run the entire status update + SMS
    // scheduling logic below a second time for the same call. Only
    // call_analyzed carries the full call_analysis outcome data this
    // handler needs, so we only dedup-guard that event specifically —
    // call_ended (if this endpoint ever receives it) has nothing to
    // lose from running again since it doesn't drive SMS sends.
    if (retellCallId && body.event === 'call_analyzed') {
      const existingCall = await getCallByRetellId(retellCallId);
      if (existingCall && existingCall.outcome) {
        console.log(`[webhook/retell] Duplicate delivery for call ${retellCallId} — already processed, skipping`);
        return res.status(200).json({ success: true, duplicate: true });
      }
    }

    // Map Retell outcome to our status.
    //
    // PRIMARY SIGNAL: call_analysis.custom_analysis_data.outcome — a
    // structured Enum field defined in the Retell dashboard under
    // "Post-Call Analysis" (e.g. booked / not_interested /
    // call_back_later / voicemail / completed_no_decision). This is a
    // hard, deterministic value Retell's analysis model is explicitly
    // asked to produce — not text we're guessing at after the fact.
    //
    // FALLBACK: if custom_analysis_data.outcome hasn't been configured
    // yet (Retell explicitly does not populate custom analysis fields
    // for calls that never connected, and won't have the field at all
    // until it's set up on the agent), we fall back to the previous
    // text-matching against call_summary so this keeps working in the
    // meantime — just less reliably.
    //
    // NOTE ON BOOKING SPECIFICALLY: actual booking confirmation never
    // comes from this webhook at all, structured or not — it comes ONLY
    // from /webhook/booking-event, fired by the n8n workflow at the
    // exact moment book_appointment genuinely succeeds. That's the one
    // place that knows for certain a booking went through, so this
    // handler intentionally treats "booked" the same as "completed" —
    // it does not set status to 'booked' itself, to avoid two different
    // code paths racing to claim the same outcome.
    let newStatus = 'attempted';
    let activityOutcome = 'no_answer';
    let notes = '';

    if (callAnalysis) {
      const structuredOutcome = callAnalysis.custom_analysis_data?.outcome?.toLowerCase() || null;
      const summary = callAnalysis.call_summary?.toLowerCase() || '';
      const userSentiment = callAnalysis.user_sentiment?.toLowerCase() || '';

      if (structuredOutcome) {
        // Hard signal available — use it directly, no guessing.
        if (structuredOutcome === 'not_interested') {
          newStatus = 'dead';
          activityOutcome = 'answered';
          notes = 'Not interested';

        } else if (structuredOutcome === 'call_back_later') {
          newStatus = 'attempted';
          activityOutcome = 'answered';
          notes = 'Asked to call back later';

        } else if (structuredOutcome === 'voicemail') {
          newStatus = 'attempted';
          activityOutcome = 'voicemail';
          notes = 'Voicemail left';

        } else {
          // 'booked' or 'completed_no_decision' or any other configured
          // value — call genuinely happened, status is "contacted"; the
          // booking-specific status change (if any) is left entirely to
          // /webhook/booking-event.
          newStatus = 'contacted';
          activityOutcome = 'answered';
          notes = callAnalysis.call_summary || 'Call completed';
        }

      } else if (summary.includes('not interested') || userSentiment === 'negative') {
        // Fallback: structured field not configured yet — text match.
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

    // Record/update the call row for dedup purposes (see the
    // getCallByRetellId check near the top of this handler) and so this
    // call's outcome is visible in the same ldm_calls table that
    // /webhook/retell-call-details populates with transcript/summary —
    // one row per real call, not split across two tables.
    if (retellCallId) {
      const structuredOutcomeForStorage = callAnalysis?.custom_analysis_data?.outcome || null;
      const existingCallRow = await getCallByRetellId(retellCallId);
      if (existingCallRow) {
        await updateCallByRetellId(retellCallId, {
          call_status: callStatus || existingCallRow.call_status,
          outcome: structuredOutcomeForStorage || existingCallRow.outcome,
        });
      } else {
        await saveCall(leadId, {
          retell_call_id: retellCallId,
          call_status: callStatus || 'answered',
          outcome: structuredOutcomeForStorage,
        });
      }
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
// DEDUP: Retell retries webhook deliveries up to 3 times if it doesn't
// get a 2xx response within 10 seconds, and call_ended + call_analyzed
// both fire with the SAME call_id at different points in the call's
// lifecycle. Every write here goes through getCallByRetellId() first:
//   - call_ended arrives first  -> no existing row -> INSERT
//   - call_analyzed arrives next, same call_id -> row exists -> UPDATE
//     (adds summary/sentiment/outcome on top of what call_ended saved)
//   - any retried delivery of either event -> row already has this
//     data -> UPDATE again is harmless (idempotent), never a duplicate
//     row.
// This replaces the previous approach of stuffing transcript/summary
// into ldm_contact_activity via logActivity()'s `extra` param, which had
// no dedup at all and put call-specific columns on a table that was
// never designed to hold them.
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
    // comes back to us inside the call object. Falls back to a phone
    // lookup if lead_id genuinely isn't present on this call for any
    // reason — same fallback pattern already proven in /booking-event,
    // applied here too so a missing dynamic variable doesn't mean the
    // whole call record is silently dropped.
    let leadId =
      call.retell_llm_dynamic_variables?.lead_id ||
      call.metadata?.lead_id ||
      null;

    if (!leadId) {
      const callerPhone = call.from_number || call.to_number || null;
      if (callerPhone) {
        const supabase = require('../supabase');
        const { data } = await supabase
          .from('ldm_leads')
          .select('id')
          .eq('phone', callerPhone)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        leadId = data?.id || null;
        if (leadId) {
          console.log(`retell-call-details: resolved lead ${leadId} via phone fallback for call ${call.call_id}`);
        }
      }
    }

    if (!leadId) {
      console.warn(`retell-call-details: no lead_id (and no phone match) on call ${call.call_id}, skipping`);
      return res.status(200).json({ received: true });
    }

    const existing = await getCallByRetellId(call.call_id);

    if (event === 'call_ended') {
      const durationSeconds = call.duration_ms ? Math.round(call.duration_ms / 1000) : 0;
      const startedAt = call.start_timestamp ? new Date(call.start_timestamp).toISOString() : null;
      const endedAt = call.end_timestamp ? new Date(call.end_timestamp).toISOString() : null;

      if (existing) {
        await updateCallByRetellId(call.call_id, {
          call_status: call.call_status || existing.call_status,
          duration_seconds: durationSeconds || existing.duration_seconds,
          transcript: call.transcript || existing.transcript,
          started_at: startedAt || existing.started_at,
          ended_at: endedAt || existing.ended_at,
        });
      } else {
        await saveCall(leadId, {
          retell_call_id: call.call_id,
          call_status: call.call_status || 'answered',
          duration_seconds: durationSeconds,
          transcript: call.transcript || null,
          started_at: startedAt,
          ended_at: endedAt,
        });
      }
    }

    if (event === 'call_analyzed') {
      const summary = call.call_analysis?.call_summary || null;
      const sentiment = call.call_analysis?.user_sentiment || null;
      const outcome = call.call_analysis?.custom_analysis_data?.outcome || null;

      if (existing) {
        await updateCallByRetellId(call.call_id, {
          summary: summary || existing.summary,
          sentiment: sentiment || existing.sentiment,
          outcome: outcome || existing.outcome,
        });
      } else {
        // call_analyzed arrived before call_ended was ever processed
        // (Retell explicitly does not guarantee webhook delivery order
        // across event types) — create the row now rather than drop
        // this data on the floor; call_ended's later/retried delivery
        // will then UPDATE this same row via the existing-row branch.
        await saveCall(leadId, {
          retell_call_id: call.call_id,
          call_status: call.call_status || 'answered',
          summary,
          sentiment,
          outcome,
        });
      }
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
