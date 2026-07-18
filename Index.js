require('dotenv').config();
const express = require('express');
const webhookRoutes = require('./routes/webhooks');
const simulatorRoutes = require('./routes/simulator');
const { startJobs } = require('./jobs/followUp');
const supabase = require('./supabase');
const { triggerRetellCall } = require('./services/retell');
const { queueDemoWebCall } = require('./services/simulator');
const {
  getLead,
  updateLeadStatus,
  setLastAction,
  incrementAttemptCount,
  logActivity,
  updateActivity,
  deleteActivity,
  moveToNurture,
  getClientSettings,
  updateClientSettings,
  getBookingEventsForClient,
  getSmsTemplate,
  getSmsTemplates,
  saveSmsTemplate,
  resolveTemplate,
  getEmailSequenceSteps,
  saveEmailSequenceStep,
  deleteEmailSequenceStep,
  getUpcomingSmsForClient,
  getUpcomingEmailsForClient,
  deleteLead,
  getCallsByLead,
} = require('./services/leads');
const { sendSMS } = require('./services/twilio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} — ${req.method} ${req.path}`);
  next();
});

// ---- WEBHOOKS (Meta + Retell) ----
app.use('/webhook', webhookRoutes);

// ---- PHONE SIMULATOR (demo only — web calls, never dials a real number) ----
app.use('/simulator', simulatorRoutes);

// ================================================
// CLIENTS
// ================================================

app.get('/clients', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ldm_clients')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/clients', async (req, res) => {
  try {
    const { business_name, niche, email, phone } = req.body;
    const { data, error } = await supabase
      .from('ldm_clients')
      .insert([{ business_name, name: business_name, niche, email, phone }])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// LEADS
// ================================================

app.get('/clients/:id/leads', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ldm_leads')
      .select('*')
      .eq('client_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/leads/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabase
      .from('ldm_leads')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deletes the lead and, via ON DELETE CASCADE in the schema, everything
// tied to it — contact activity, scheduled SMS, nurture sequence rows,
// booking events. One delete, genuinely complete.
app.delete('/leads/:id', async (req, res) => {
  try {
    await deleteLead(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/leads/:id/activity', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ldm_contact_activity')
      .select('*')
      .eq('lead_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EDIT / DELETE a single activity/event row — powers the three-dot menu
// on each timeline event. Editable fields are type/outcome/notes only;
// see updateActivity() for why system-reported fields stay locked.
app.patch('/activity/:id', async (req, res) => {
  try {
    const { activity_type, outcome, notes } = req.body;
    const updated = await updateActivity(req.params.id, { activity_type, outcome, notes });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/activity/:id', async (req, res) => {
  try {
    await deleteActivity(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// CALL HISTORY — distinct from /activity above. This reads the
// dedicated ldm_calls table (transcript, summary, sentiment, outcome,
// duration, recording_url), not the generic activity log. Powers the
// "Call History" section on the lead detail panel, so a lead's actual
// call transcripts/outcomes are visible directly under their status,
// not buried generically inside the activity feed.
// ================================================
app.get('/leads/:id/calls', async (req, res) => {
  try {
    const calls = await getCallsByLead(req.params.id);
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// SMS / EMAIL ACTIVITY — admin-level pages
// Returns every SMS or email activity row for a client's leads, with the
// lead's name/phone attached, so the SMS and Email pages can show a flat
// timeline without needing N+1 requests per lead.
// ================================================

// ================================================
// SCHEDULED — upcoming SMS/emails not yet sent, for the "Scheduled"
// section on the SMS and Email pages. Distinct from /activity/sms and
// /activity/email below, which only show what's already gone out.
// ================================================

app.get('/clients/:id/scheduled/sms', async (req, res) => {
  try {
    const rows = await getUpcomingSmsForClient(req.params.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/clients/:id/scheduled/email', async (req, res) => {
  try {
    const rows = await getUpcomingEmailsForClient(req.params.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================

app.get('/clients/:id/activity/sms', async (req, res) => {
  try {
    const { data: leads, error: leadsErr } = await supabase
      .from('ldm_leads')
      .select('id, name, phone')
      .eq('client_id', req.params.id);
    if (leadsErr) throw leadsErr;

    const leadIds = (leads || []).map(l => l.id);
    if (leadIds.length === 0) return res.json([]);

    const { data, error } = await supabase
      .from('ldm_contact_activity')
      .select('*')
      .in('lead_id', leadIds)
      .eq('activity_type', 'sms')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const leadMap = Object.fromEntries(leads.map(l => [l.id, l]));
    const enriched = (data || []).map(row => ({ ...row, lead: leadMap[row.lead_id] || null }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/clients/:id/activity/email', async (req, res) => {
  try {
    const { data: leads, error: leadsErr } = await supabase
      .from('ldm_leads')
      .select('id, name, phone, email')
      .eq('client_id', req.params.id);
    if (leadsErr) throw leadsErr;

    const leadIds = (leads || []).map(l => l.id);
    if (leadIds.length === 0) return res.json([]);

    const { data, error } = await supabase
      .from('ldm_contact_activity')
      .select('*')
      .in('lead_id', leadIds)
      .eq('activity_type', 'email')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const leadMap = Object.fromEntries(leads.map(l => [l.id, l]));
    const enriched = (data || []).map(row => ({ ...row, lead: leadMap[row.lead_id] || null }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// CLIENT SETTINGS — timezone + follow-up timing
// ================================================

app.get('/clients/:id/settings', async (req, res) => {
  try {
    const result = await getClientSettings(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/clients/:id/settings', async (req, res) => {
  try {
    const { timezone, followup_settings } = req.body;
    const data = await updateClientSettings(req.params.id, { timezone, followup_settings });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// BOOKING EVENTS — real booked/rescheduled/cancelled history,
// fed by the n8n workflow via /webhook/booking-event
// ================================================

app.get('/clients/:id/bookings', async (req, res) => {
  try {
    const data = await getBookingEventsForClient(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// SMS TEMPLATES — the 5 editable message slots used by the real
// sequence logic in FollowUp.js / Webhooks.js / Simulator.routes.js
// ================================================

app.get('/clients/:id/sms-templates', async (req, res) => {
  try {
    const templates = await getSmsTemplates(req.params.id);
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/clients/:id/sms-templates/:slot', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    const data = await saveSmsTemplate(req.params.id, req.params.slot, message);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// EMAIL SEQUENCE STEPS — editable nurture content, content only.
// Timing between steps is controlled separately in client settings
// (followup_settings.nurture_intervals_days).
// ================================================

app.get('/clients/:id/email-sequence', async (req, res) => {
  try {
    const steps = await getEmailSequenceSteps(req.params.id);
    res.json(steps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/clients/:id/email-sequence/:stepOrder', async (req, res) => {
  try {
    const { delay_days, subject, body } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });
    const data = await saveEmailSequenceStep(
      req.params.id,
      parseInt(req.params.stepOrder, 10),
      delay_days || 7,
      subject,
      body
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/clients/:id/email-sequence/:stepOrder', async (req, res) => {
  try {
    await deleteEmailSequenceStep(req.params.id, parseInt(req.params.stepOrder, 10));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// CALL LEAD — triggered by the dashboard "Call Lead" button
// Pulls full lead context and fires Retell with it
// ================================================

app.post('/call', async (req, res) => {
  try {
    const { lead_id } = req.body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id required' });

    const lead = await getLead(lead_id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // DEMO LEADS — never dial a real phone number. Route to the same
    // web-call simulator path used by /webhook/meta when demo:true.
    // This is the fix: is_demo is now read from the lead itself (saved
    // at creation time), not re-derived from the original request body,
    // so this works correctly no matter when "Call Lead" is clicked.
    if (lead.is_demo) {
      // BUG FIX: this branch returned early without ever calling
      // incrementAttemptCount — every demo call was logged as activity
      // but never counted, which is why attempt_count and the dashboard
      // stats (e.g. "2 attempted" after 3 real demo calls) didn't match
      // what actually happened.
      await incrementAttemptCount(lead_id);
      queueDemoWebCall(lead);
      await setLastAction(lead_id, 'Call in progress');
      return res.json({ success: true, demo: true });
    }

    // REAL LEADS — fire an actual outbound phone call via Retell
    const attemptNumber = await incrementAttemptCount(lead_id);
    const result = await triggerRetellCall(lead, attemptNumber);

    if (result.success) {
      await updateLeadStatus(lead_id, 'attempted', { last_action: 'Calling now' });
      await logActivity(lead_id, 'call', 'no_answer', `Manual call triggered — attempt ${attemptNumber}`);
    } else {
      await setLastAction(lead_id, "Couldn't reach — will retry");
      await logActivity(lead_id, 'call', 'bounced', result.error || 'Call failed to trigger');  // internal note stays technical for debugging
    }

    res.json({ success: result.success, callId: result.callId || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// SIMULATE OUTCOMES — internal testing only
// Lets us test follow up logic without real calls connecting
// Not used by the live dashboard — call these directly for testing
// ================================================

app.post('/simulate/no-answer', async (req, res) => {
  try {
    const { lead_id } = req.body;
    const attemptNumber = await incrementAttemptCount(lead_id);
    await updateLeadStatus(lead_id, 'attempted', { last_action: 'Called — no answer' });
    await logActivity(lead_id, 'call', 'no_answer', `Simulated no answer — attempt ${attemptNumber}`);

    // Fire the SMS exactly like the real flow would — same template
    // lookup as FollowUp.js/Webhooks.js, so testing this endpoint
    // genuinely reflects what a real lead would receive.
    const lead = await getLead(lead_id);
    const slot = attemptNumber === 1 ? 'no_answer_1' : attemptNumber === 2 ? 'no_answer_2' : 'no_answer_final';
    const { businessName } = await getClientSettings(lead.client_id);
    const template = await getSmsTemplate(lead.client_id, slot);
    const message = resolveTemplate(template, lead, businessName);
    const smsResult = await sendSMS(lead.phone, message);
    await logActivity(lead_id, 'sms', smsResult.success ? 'sent' : 'bounced', message);
    await setLastAction(lead_id, 'SMS sent — no answer on call');

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/simulate/voicemail', async (req, res) => {
  try {
    const { lead_id } = req.body;
    const attemptNumber = await incrementAttemptCount(lead_id);
    await updateLeadStatus(lead_id, 'attempted', { last_action: 'Voicemail left' });
    await logActivity(lead_id, 'voicemail', 'voicemail', `Simulated voicemail — attempt ${attemptNumber}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/simulate/interested', async (req, res) => {
  try {
    const { lead_id } = req.body;
    await updateLeadStatus(lead_id, 'booked', { last_action: 'Booked via call', booked: true, booking_date: new Date().toISOString() });
    await logActivity(lead_id, 'call', 'answered', 'Simulated — interested and booked');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/simulate/not-interested', async (req, res) => {
  try {
    const { lead_id } = req.body;
    await updateLeadStatus(lead_id, 'dead', { last_action: 'Not interested' });
    await logActivity(lead_id, 'call', 'answered', 'Simulated — not interested');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/simulate/exhaust-sequence', async (req, res) => {
  try {
    const { lead_id } = req.body;
    await moveToNurture(lead_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================
// HEALTH + TEST
// ================================================

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/test/lead', async (req, res) => {
  const fakeLead = {
    client_id: req.body.client_id || 'test-client-id',
    name: req.body.name || 'John Smith',
    phone: req.body.phone || '+1234567890',
    email: req.body.email || 'test@example.com',
    offer_seen: req.body.offer_seen || 'Free roofing inspection',
    demo: req.body.demo === true,
  };
  // Forward into the real /webhook/meta handler by re-invoking it as an
  // internal request, rather than calling .handle() (which doesn't exist
  // on an Express router and would throw).
  req.url = '/meta';
  req.body = fakeLead;
  return webhookRoutes(req, res, (err) => {
    if (err) res.status(500).json({ error: err.message });
  });
});

// ---- SERVE PHONE SIMULATOR ----
app.get('/simulator-screen', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile('/app/simulator.html');
});

// ---- SERVE DASHBOARD ----
// Cache-Control: no-store is critical here. Express's sendFile() sets
// ETag/conditional-cache headers by default, which means a browser can
// legitimately receive a 304 and keep showing an OLD cached copy of
// this file even after a fresh deploy — the person sees stale UI/JS
// and has no way to know a real update already shipped. This is very
// likely what caused "I fixed the code but it still shows the old
// behavior" reports — the deployed file was correct, the browser just
// never re-fetched it.
app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile('/app/Index.html');
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`BotCipher backend running on port ${PORT}`);
  startJobs();
});

module.exports = app;
