require('dotenv').config();
const express = require('express');
const path = require('path');
const webhookRoutes = require('./routes/webhooks');
const { startJobs } = require('./jobs/followUp');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} — ${req.method} ${req.path}`);
  next();
});

app.use(express.static(path.join(__dirname, '..')));

app.use('/webhook', webhookRoutes);

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
  };
  req.body = fakeLead;
  return require('./routes/webhooks').handle(req, res);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
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
