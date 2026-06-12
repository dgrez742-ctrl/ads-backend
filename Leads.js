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
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Update lead status
async function updateLeadStatus(leadId, status, extraFields = {}) {
  const { error } = await supabase
    .from('ldm_leads')
    .update({ status, ...extraFields })
    .eq('id', leadId);

  if (error) throw error;
}

// Log a contact activity (call, sms, email)
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

// Get count of contact attempts for a lead
async function getAttemptCount(leadId) {
  const { data, error } = await supabase
    .from('ldm_contact_activity')
    .select('id')
    .eq('lead_id', leadId)
    .eq('activity_type', 'call');

  if (error) return 0;
  return data.length;
}

// Get leads that need follow up
// Called by the cron job every hour
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

// Get leads stuck in 'new' status too long (fallback for missed Retell outcomes)
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
  // Progressive intervals: week 1, week 2, week 3, every 2 weeks, monthly
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
  await updateLeadStatus(leadId, 'nurture');

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
  updateLeadStatus,
  logActivity,
  getAttemptCount,
  getLeadsForFollowUp,
  getStalledLeads,
  getNurtureLeadsDue,
  updateNurtureStep,
  moveToNurture,
};
