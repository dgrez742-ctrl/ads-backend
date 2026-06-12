require('dotenv').config();
const express = require('express');
const webhookRoutes = require('./routes/webhooks');
const { startJobs } = require('./jobs/followUp');

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic request logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} — ${req.method} ${req.path}`);
  next();
});

// --------------------------------------------------------
// ROUTES
// --------------------------------------------------------
app.use('/webhook', webhookRoutes);

// Health check — Railway/Render uses this to confirm app is running
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test endpoint — inject a fake lead to test the full pipeline
app.post('/test/lead', async (req, res) => {
  const fakeLead = {
    client_id: req.body.client_id || 'test-client-id',
    campaign_id: null,
    name: req.body.name || 'John Smith',
    phone: req.body.phone || '+1234567890',
    email: req.body.email || 'test@example.com',
    offer_seen: req.body.offer_seen || 'Free roofing inspection',
  };

  // Forward to the Meta webhook handler
  req.body = fakeLead;
  return require('./routes/webhooks').handle(req, res);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// --------------------------------------------------------
// START SERVER + JOBS
// --------------------------------------------------------
app.listen(PORT, () => {
  console.log(`BotCipher backend running on port ${PORT}`);
  startJobs();
});

module.exports = app;
