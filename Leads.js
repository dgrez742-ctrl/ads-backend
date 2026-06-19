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
async function logActivity(leadId, activityType, outcome, notes = '') {
  const { error } = await supabase
    .from('ldm_contact_activity')
    .insert([{
      lead_id: leadId,
      activity_type: activityType,
      outcome,
      notes,
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

// Update nurture sequence — set next send date based on step
async function updateNurtureStep(nurtureId, currentStep) {
  const intervals = [7, 7, 7, 14, 30, 30, 30];
  const daysUntilNext = intervals[currentStep] || 30;
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
};
