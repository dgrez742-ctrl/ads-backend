const express = require('express');
const router = express.Router();
const { takePendingCall, clearActiveCall, getCallStatus, setCallStatus } = require('../services/simulator');
const { logActivity, updateLeadStatus, setLastAction } = require('../services/leads');

// --------------------------------------------------------
// GET /simulator/pending-call
// Polled by the simulator frontend every ~1.5s.
// Returns { lead, access_token, call_id } once the demo web call session
// is ready, or { lead: null } if nothing is waiting.
// --------------------------------------------------------
router.get('/pending-call', (req, res) => {
  const call = takePendingCall();
  if (!call) {
    return res.json({ lead: null });
  }
  res.json({
    lead: call.lead,
    access_token: call.access_token,
    call_id: call.call_id,
  });
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
      await logActivity(lead_id, 'call', 'answered', 'Demo call answered');
      await setLastAction(lead_id, 'Demo call answered');
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
// the frontend disconnects it client-side. This just logs the outcome.
// --------------------------------------------------------
router.post('/decline', async (req, res) => {
  try {
    const { lead_id } = req.body;
    setCallStatus('declined');
    if (lead_id) {
      await logActivity(lead_id, 'call', 'no_answer', 'Demo call declined');
      await setLastAction(lead_id, 'Demo call declined');
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
      await logActivity(lead_id, 'call', 'answered', `Demo call ended — duration ${duration || 0}s`);
      await setLastAction(lead_id, 'Demo call completed');
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
