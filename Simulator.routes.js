const express = require('express');
const router = express.Router();
const { takePendingCall, clearActiveCall, getCallStatus, setCallStatus } = require('../services/simulator');
const {
  logActivity, updateLeadStatus, setLastAction, setLastAnsweredCallAt, getClientSettings,
  scheduleSms, getLead, getSmsTemplate, resolveTemplate, incrementAttemptCount, getAttemptCount,
} = require('../services/leads');
const { computeSmsSendTime } = require('../services/timezone');
const { sendSMS } = require('../services/twilio');

// Internal notes (logActivity / console) stay technical and say "demo" —
// useful for debugging. last_action is what the dashboard shows by
// default, so it stays generic and never mentions "demo" — same wording
// a client would see for a real call.

// --------------------------------------------------------
// GET /simulator/pending-call
// Polled by the simulator frontend every ~1.5s.
// Returns { lead, caller, access_token, call_id } once the demo web call
// session is ready, or { lead: null } if nothing is waiting. `caller` is
// the business's own name/number — what the ring screen should display —
// kept separate from `lead`, which is internal session data only.
// --------------------------------------------------------
router.get('/pending-call', (req, res) => {
  const call = takePendingCall();
  if (!call) {
    return res.json({ lead: null });
  }
  res.json({
    lead: call.lead,
    caller: call.caller,
    access_token: call.access_token,
    call_id: call.call_id,
  });
});

// --------------------------------------------------------
// POST /simulator/ringing
// Called by Simulator.html the instant triggerIncomingCall() actually
// runs — the ring screen is genuinely on screen and the ringtone is
// genuinely playing. This is the fix for the dashboard's status bar
// drifting out of sync with reality: previously 'ringing' was set the
// moment the Retell session was technically ready (in queueDemoWebCall),
// which is not the same moment a human is actually seeing the phone
// ring — those two events happen on two independently-polling pages
// with no shared clock between them.
// --------------------------------------------------------
router.post('/ringing', (req, res) => {
  setCallStatus('ringing');
  res.json({ success: true });
});

// --------------------------------------------------------
// POST /simulator/answer
// Logged when the demo call is answered on camera.
// --------------------------------------------------------
router.post('/answer', async (req, res) => {
  try {
    const { lead_id } = req.body;
    setCallStatus('answered');
    if (lead_id) {
      // This was the actual cause of leads staying stuck on "attempted"
      // after being genuinely answered — status was never updated here,
      // only the last_action text was. Fixed: status now moves to
      // 'contacted' the moment the call is answered.
      await updateLeadStatus(lead_id, 'contacted', { last_action: 'Answered call' });
      await logActivity(lead_id, 'call', 'answered', 'Call answered');
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Simulator answer error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// POST /simulator/decline
// The web call session was already silently connecting in the background;
// the frontend disconnects it client-side. This logs the outcome AND
// sends the no-answer SMS immediately — NOT deferred to the hourly
// follow-up cron (FollowUp.js). That cron is only responsible for
// re-attempting the CALL on its day-paced schedule; the SMS itself must
// go out right away, in this same request, every time.
// --------------------------------------------------------
router.post('/decline', async (req, res) => {
  try {
    const { lead_id } = req.body;
    setCallStatus('declined');
    if (lead_id) {
      await updateLeadStatus(lead_id, 'attempted', { last_action: 'No answer' });
      await logActivity(lead_id, 'call', 'no_answer', 'Call declined');

      // attempt_count was already incremented by /call at the moment
      // this call was triggered (see Index.js) — read it here rather
      // than incrementing again, so the slot picked matches THIS call.
      const lead = await getLead(lead_id);
      const attemptCount = lead.attempt_count || 1;
      const slot = attemptCount <= 1 ? 'no_answer_1' : attemptCount === 2 ? 'no_answer_2' : 'no_answer_final';
      const { businessName } = await getClientSettings(lead.client_id);
      const template = await getSmsTemplate(lead.client_id, slot);
      const message = resolveTemplate(template, lead, businessName);
      const smsResult = await sendSMS(lead.phone, message);
      await logActivity(lead_id, 'sms', smsResult.success ? 'sent' : 'bounced', message);
      await setLastAction(lead_id, 'SMS sent — no answer on call');
    }
    clearActiveCall();
    setTimeout(() => setCallStatus('idle'), 2000); // brief window so the dashboard bar can show "Declined" before resetting
    res.json({ success: true });
  } catch (err) {
    console.error('Simulator decline error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// POST /simulator/end
// Demo call ended (hung up) after being answered.
// --------------------------------------------------------
router.post('/end', async (req, res) => {
  try {
    const { lead_id, duration } = req.body;
    setCallStatus('ended');
    if (lead_id) {
      await setLastAction(lead_id, 'Call completed');
      await logActivity(lead_id, 'call', 'answered', `Call ended, duration ${duration || 0}s`);

      const answeredAt = new Date();
      await setLastAnsweredCallAt(lead_id, answeredAt);

      // If the call ended in a booking, the agent's book_appointment
      // function already fired (handled via /webhook/booking-event from
      // n8n) and status will already be 'booked' by the time this runs
      // in the normal case. Re-check here as a safeguard so a booked
      // lead never also gets a "still want to book?" follow-up SMS.
      const lead = await getLead(lead_id);
      if (lead.status !== 'booked') {
        const { timezone, settings, businessName } = await getClientSettings(lead.client_id);
        const { variant, sendAt } = computeSmsSendTime(answeredAt, timezone, settings);
        const slot = variant === 'morning' ? 'followup_morning' : 'followup_evening';
        const template = await getSmsTemplate(lead.client_id, slot);
        const message = resolveTemplate(template, lead, businessName);
        await scheduleSms(lead_id, message, variant, sendAt);
      }
    }
    clearActiveCall();
    setTimeout(() => setCallStatus('idle'), 2000);
    res.json({ success: true });
  } catch (err) {
    console.error('Simulator end error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// GET /simulator/status
// Polled by the dashboard's calling bar so it reflects real state —
// connecting / ringing / answered / declined / ended — instead of
// fading on a fixed timeout regardless of what actually happened.
// --------------------------------------------------------
router.get('/status', (req, res) => {
  res.json(getCallStatus());
});

module.exports = router;
