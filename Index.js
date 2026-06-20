require('dotenv').config();
const express = require('express');
const webhookRoutes = require('./routes/webhooks');
const simulatorRoutes = require('./routes/simulator');
const { startJobs } = require('./jobs/followUp');
const supabase = require('./supabase');
const { triggerRetellCall } = require('./services/retell');
const {
  getLead,
  updateLeadStatus,
  setLastAction,
  incrementAttemptCount,
  logActivity,
  moveToNurture,
} = require('./services/leads');
const { sendSMS, getSMSMessage } = require('./services/twilio');

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

    const attemptNumber = await incrementAttemptCount(lead_id);

    const result = await triggerRetellCall(lead, attemptNumber);

    if (result.success) {
      await updateLeadStatus(lead_id, 'attempted', { last_action: 'Calling now' });
      await logActivity(lead_id, 'call', 'no_answer', `Manual call triggered — attempt ${attemptNumber}`);
    } else {
      await setLastAction(lead_id, 'Call failed to trigger');
      await logActivity(lead_id, 'call', 'bounced', result.error || 'Call failed to trigger');
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

    // Fire the SMS exactly like the real flow would
    const lead = await getLead(lead_id);
    const message = getSMSMessage(lead, attemptNumber);
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
  res.sendFile('/app/simulator.html');
});

// ---- SERVE DASHBOARD ----
app.get('*', (req, res) => {
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
