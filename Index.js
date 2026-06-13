require('dotenv').config();
const express = require('express');
const path = require('path');
const webhookRoutes = require('./routes/webhooks');
const { startJobs } = require('./jobs/followUp');
const supabase = require('./supabase');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} — ${req.method} ${req.path}`);
  next();
});

// ---- API ROUTES ----
app.use('/webhook', webhookRoutes);

// GET all clients
app.get('/clients', async (req, res) => {
  try {
    const { data, error } = await supabase.from('ldm_clients').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create client
app.post('/clients', async (req, res) => {
  try {
    const { business_name, niche, email, phone } = req.body;
    const { data, error } = await supabase.from('ldm_clients').insert([{ business_name, niche, email, phone }]).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET leads for a client
app.get('/clients/:id/leads', async (req, res) => {
  try {
    const { data, error } = await supabase.from('ldm_leads').select('*').eq('client_id', req.params.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update lead status
app.patch('/leads/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabase.from('ldm_leads').update({ status }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET activity for a lead
app.get('/leads/:id/activity', async (req, res) => {
  try {
    const { data, error } = await supabase.from('ldm_contact_activity').select('*').eq('lead_id', req.params.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test lead injection
app.post('/test/lead', async (req, res) => {
  const fakeLead = {
    client_id: req.body.client_id || 'test-client-id',
    name: req.body.name || 'John Smith',
    phone: req.body.phone || '+1234567890',
    email: req.body.email || 'test@example.com',
    offer_seen: req.body.offer_seen || 'Free roofing inspection',
  };
  req.body = fakeLead;
  return require('./routes/webhooks').handle(req, res);
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
