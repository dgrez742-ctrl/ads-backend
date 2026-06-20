const supabase = require('../supabase');

// Check if lead already exists (deduplication by phone + client)
async function leadExists(clientId, phone) {
  const { data } = await supabase
    .from('ldm_leads')
    .select('id')
    .eq('client_id', clientId)
    .eq('phone', phone)
    .single();

  return !!data;
}

// Create a new lead
async function createLead(leadData) {
  const { data, error } = await supabase
    .from('ldm_leads')
    .insert([{
      client_id: leadData.client_id,
      campaign_id: leadData.campaign_id || null,
      name: leadData.name,
      phone: leadData.phone,
      email: leadData.email,
      offer_seen: leadData.offer_seen || null,
      status: 'new',
      last_action: 'Lead received',
      attempt_count: 0,
      is_demo: leadData.is_demo === true,
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Get a single lead by id
async function getLead(leadId) {
  const { data, error } = await supabase
    .from('ldm_leads')
    .select('*')
    .eq('id', leadId)
    .single();

  if (error) throw error;
  return data;
}

// Update lead status (and optionally last_action)
async function updateLeadStatus(leadId, status, extraFields = {}) {
  const { error } = await supabase
    .from('ldm_leads')
    .update({ status, updated_at: new Date().toISOString(), ...extraFields })
    .eq('id', leadId);

  if (error) throw error;
}

// Update just the last_action text shown on the dashboard
async function setLastAction(leadId, text) {
  const { error } = await supabase
    .from('ldm_leads')
    .update({ last_action: text, updated_at: new Date().toISOString() })
    .eq('id', leadId);

  if (error) throw error;
}

// Increment attempt_count by 1 and return the new value
async function incrementAttemptCount(leadId) {
  const lead = await getLead(leadId);
  const newCount = (lead.attempt_count || 0) + 1;

  const { error } = await supabase
    .from('ldm_leads')
    .update({ attempt_count: newCount })
    .eq('id', leadId);

  if (error) throw error;
  return newCount;
}

// Log a contact activity (call, sms, email, voicemail)
// extra: { transcript, call_summary, sentiment, duration_seconds, retell_call_id }
// All optional — every existing call site that only passes 4 args keeps
// working exactly as before.
async function logActivity(leadId, activityType, outcome, notes = '', extra = {}) {
  const { error } = await supabase
    .from('ldm_contact_activity')
    .insert([{
      lead_id: leadId,
      activity_type: activityType,
      outcome,
      notes,
      ...extra,
    }]);

  if (error) throw error;
}

// Get count of contact attempts for a lead (call activity rows)
async function getAttemptCount(leadId) {
  const { data, error } = await supabase
    .from('ldm_contact_activity')
    .select('id')
    .eq('lead_id', leadId)
    .eq('activity_type', 'call');

  if (error) return 0;
  return data.length;
}

// Get leads that need follow up — called by cron every hour
async function getLeadsForFollowUp() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('ldm_leads')
    .select('*, ldm_contact_activity(*)')
    .in('status', ['new', 'attempted'])
    .lt('updated_at', oneDayAgo);

  if (error) return [];
  return data || [];
}

// Get leads stuck in 'new' status too long (missed Retell outcome fallback)
async function getStalledLeads() {
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('ldm_leads')
    .select('*')
    .eq('status', 'new')
    .lt('created_at', thirtyMinsAgo);

  if (error) return [];
  return data || [];
}

// Get nurture leads due for contact
async function getNurtureLeadsDue() {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('ldm_nurture_sequence')
    .select('*, ldm_leads(*)')
    .eq('active', true)
    .lt('next_send_at', now);

  if (error) return [];
  return data || [];
}

// Update nurture sequence — set next send date based on step.
// clientSettings is optional; falls back to the same defaults as before
// if not provided, so existing call sites don't break.
async function updateNurtureStep(nurtureId, currentStep, clientSettings) {
  const intervals = (clientSettings && clientSettings.nurture_intervals_days) || [7, 7, 7, 14, 30, 30, 30];
  const daysUntilNext = intervals[currentStep] || intervals[intervals.length - 1] || 30;
  const nextSendAt = new Date(Date.now() + daysUntilNext * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('ldm_nurture_sequence')
    .update({
      step_number: currentStep + 1,
      last_sent_at: new Date().toISOString(),
      next_send_at: nextSendAt,
    })
    .eq('id', nurtureId);

  if (error) throw error;
}

// Move a lead into nurture sequence
async function moveToNurture(leadId) {
  await updateLeadStatus(leadId, 'nurture', { last_action: 'Moved to nurture' });

  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('ldm_nurture_sequence')
    .insert([{
      lead_id: leadId,
      step_number: 1,
      next_send_at: sevenDaysFromNow,
      active: true,
    }]);

  if (error) throw error;
}

// --------------------------------------------------------
// CLIENT SETTINGS — timezone + follow-up timing, used by the SMS
// scheduling logic and nurture sequencing. Falls back to defaults if a
// client somehow has no row yet (shouldn't happen since the column has
// a DB default, but defensive either way).
// --------------------------------------------------------
const { mergeSettings } = require('./timezone');

async function getClientSettings(clientId) {
  const { data, error } = await supabase
    .from('ldm_clients')
    .select('timezone, followup_settings')
    .eq('id', clientId)
    .single();

  if (error || !data) {
    return { timezone: 'America/New_York', settings: mergeSettings({}) };
  }

  return {
    timezone: data.timezone || 'America/New_York',
    settings: mergeSettings(data.followup_settings),
  };
}

async function updateClientSettings(clientId, { timezone, followup_settings }) {
  const update = {};
  if (timezone) update.timezone = timezone;
  if (followup_settings) update.followup_settings = followup_settings;

  const { data, error } = await supabase
    .from('ldm_clients')
    .update(update)
    .eq('id', clientId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Record the most recent answered-call timestamp on the lead itself.
// Edge case fix: SMS timing must key off the MOST RECENT answered call,
// not the first one — a lead called twice in one day should have its
// follow-up timing based on the second call, not stale data from the
// first.
async function setLastAnsweredCallAt(leadId, whenUtc = new Date()) {
  const { error } = await supabase
    .from('ldm_leads')
    .update({ last_answered_call_at: whenUtc.toISOString() })
    .eq('id', leadId);

  if (error) throw error;
}

// --------------------------------------------------------
// SCHEDULED SMS — real, cancellable rows instead of a fire-and-forget
// setTimeout. A booking event can explicitly cancel a pending row;
// the cron job picks up anything due.
// --------------------------------------------------------

async function scheduleSms(leadId, message, variant, sendAtUtc) {
  const { data, error } = await supabase
    .from('ldm_scheduled_sms')
    .insert([{
      lead_id: leadId,
      message,
      variant,
      scheduled_for: sendAtUtc.toISOString(),
      status: 'scheduled',
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Cancel any still-pending scheduled SMS for a lead — called when a
// booking event comes in, so a lead who just booked doesn't also get a
// "still want to book?" text a few hours later.
async function cancelScheduledSmsForLead(leadId, reason) {
  const { error } = await supabase
    .from('ldm_scheduled_sms')
    .update({ status: 'cancelled', cancelled_reason: reason })
    .eq('lead_id', leadId)
    .eq('status', 'scheduled');

  if (error) throw error;
}

// Get every scheduled SMS that's actually due — called by the cron job.
async function getDueScheduledSms() {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('ldm_scheduled_sms')
    .select('*, ldm_leads(*)')
    .eq('status', 'scheduled')
    .lte('scheduled_for', now);

  if (error) return [];
  return data || [];
}

async function markScheduledSmsSent(id) {
  const { error } = await supabase
    .from('ldm_scheduled_sms')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;
}

async function markScheduledSmsSkipped(id, reason) {
  const { error } = await supabase
    .from('ldm_scheduled_sms')
    .update({ status: 'skipped', cancelled_reason: reason })
    .eq('id', id);

  if (error) throw error;
}

// --------------------------------------------------------
// BOOKING EVENTS — from the n8n workflow, the one place that genuinely
// knows when book_appointment / reschedule_appointment /
// cancel_appointment actually succeeded.
// --------------------------------------------------------

async function recordBookingEvent(leadId, eventType, appointmentDate, notes) {
  const { error } = await supabase
    .from('ldm_booking_events')
    .insert([{
      lead_id: leadId,
      event_type: eventType,
      appointment_date: appointmentDate || null,
      notes: notes || null,
    }]);

  if (error) throw error;
}

async function getBookingEventsForClient(clientId) {
  const { data: leads, error: leadsErr } = await supabase
    .from('ldm_leads')
    .select('id, name, phone')
    .eq('client_id', clientId);

  if (leadsErr) return [];
  const leadIds = (leads || []).map(l => l.id);
  if (leadIds.length === 0) return [];

  const { data, error } = await supabase
    .from('ldm_booking_events')
    .select('*')
    .in('lead_id', leadIds)
    .order('created_at', { ascending: false });

  if (error) return [];

  const leadMap = Object.fromEntries(leads.map(l => [l.id, l]));
  return (data || []).map(row => ({ ...row, lead: leadMap[row.lead_id] || null }));
}

module.exports = {
  leadExists,
  createLead,
  getLead,
  updateLeadStatus,
  setLastAction,
  incrementAttemptCount,
  logActivity,
  getAttemptCount,
  getLeadsForFollowUp,
  getStalledLeads,
  getNurtureLeadsDue,
  updateNurtureStep,
  moveToNurture,
  getClientSettings,
  updateClientSettings,
  setLastAnsweredCallAt,
  scheduleSms,
  cancelScheduledSmsForLead,
  getDueScheduledSms,
  markScheduledSmsSent,
  markScheduledSmsSkipped,
  recordBookingEvent,
  getBookingEventsForClient,
};
