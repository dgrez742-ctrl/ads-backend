const cron = require('node-cron');
const { getLeadsForFollowUp, getStalledLeads, getNurtureLeadsDue, updateLeadStatus, logActivity, getAttemptCount, moveToNurture, updateNurtureStep } = require('../services/leads');
const { triggerRetellCall } = require('../services/retell');
const { sendSMS, getSMSMessage } = require('../services/twilio');
const supabase = require('../supabase');

// --------------------------------------------------------
// FOLLOW UP JOB — runs every hour
// Checks for leads that need next follow up action
// --------------------------------------------------------
async function runFollowUpJob() {
  console.log('Running follow up job...');

  try {
    const leads = await getLeadsForFollowUp();

    for (const lead of leads) {
      const attemptCount = await getAttemptCount(lead.id);

      // Follow up sequence:
      // Attempt 1 — already done (initial call on lead intake)
      // Attempt 2 — call again next day
      // Attempt 3 — call again day after
      // Attempt 4 — final call + final SMS + final email
      // After 4 attempts — move to nurture

      if (attemptCount === 1) {
        // Day 2 — call again
        console.log(`Lead ${lead.id} — attempt 2`);
        const result = await triggerRetellCall(lead, 2);
        await logActivity(lead.id, 'call', result.success ? 'no_answer' : 'bounced', 'Day 2 follow up call');

      } else if (attemptCount === 2) {
        // Day 3 — call + SMS
        console.log(`Lead ${lead.id} — attempt 3`);
        const result = await triggerRetellCall(lead, 3);
        await logActivity(lead.id, 'call', result.success ? 'no_answer' : 'bounced', 'Day 3 follow up call');

        const message = getSMSMessage(lead, 2);
        const smsResult = await sendSMS(lead.phone, message);
        await logActivity(lead.id, 'sms', smsResult.success ? 'sent' : 'bounced', message);

      } else if (attemptCount === 3) {
        // Day 4 — final call + final SMS
        console.log(`Lead ${lead.id} — final attempt`);
        const result = await triggerRetellCall(lead, 4);
        await logActivity(lead.id, 'call', result.success ? 'no_answer' : 'bounced', 'Final follow up call');

        const message = getSMSMessage(lead, 3);
        const smsResult = await sendSMS(lead.phone, message);
        await logActivity(lead.id, 'sms', smsResult.success ? 'sent' : 'bounced', message);

      } else if (attemptCount >= 4) {
        // Exhausted — move to nurture
        console.log(`Lead ${lead.id} — moving to nurture`);
        await moveToNurture(lead.id);
      }
    }

  } catch (err) {
    console.error('Follow up job error:', err.message);
  }
}

// --------------------------------------------------------
// STALLED LEADS JOB — runs every 30 mins
// Catches leads stuck in 'new' status (Retell outcome missed)
// --------------------------------------------------------
async function runStalledLeadsJob() {
  console.log('Checking for stalled leads...');

  try {
    const stalledLeads = await getStalledLeads();

    for (const lead of stalledLeads) {
      console.warn(`Stalled lead detected: ${lead.id} — retrying call`);
      await updateLeadStatus(lead.id, 'attempted');
      const result = await triggerRetellCall(lead, 1);
      await logActivity(lead.id, 'call', result.success ? 'no_answer' : 'bounced', 'Stalled lead retry');
    }

  } catch (err) {
    console.error('Stalled leads job error:', err.message);
  }
}

// --------------------------------------------------------
// NURTURE JOB — runs once a day
// Sends nurture emails and monthly calls to cold leads
// --------------------------------------------------------
async function runNurtureJob() {
  console.log('Running nurture job...');

  try {
    const nurtureLeads = await getNurtureLeadsDue();

    for (const item of nurtureLeads) {
      const lead = item.ldm_leads;
      const step = item.step_number;

      console.log(`Nurture lead ${lead.id} — step ${step}`);

      // Every 3rd step — attempt a call (monthly touch)
      if (step % 3 === 0) {
        const result = await triggerRetellCall(lead, step);
        await logActivity(lead.id, 'call', result.success ? 'no_answer' : 'bounced', `Nurture call step ${step}`);
      }

      // Always send email on nurture steps
      // Email sending plugs into your existing email system
      // Just log it here for now — connect your emailer later
      await logActivity(lead.id, 'email', 'sent', `Nurture email step ${step}`);

      // Update nurture to next step
      await updateNurtureStep(item.id, step);
    }

  } catch (err) {
    console.error('Nurture job error:', err.message);
  }
}

// --------------------------------------------------------
// REGISTER ALL CRON JOBS
// --------------------------------------------------------
function startJobs() {
  // Follow up — every hour
  cron.schedule('0 * * * *', runFollowUpJob);

  // Stalled leads check — every 30 minutes
  cron.schedule('*/30 * * * *', runStalledLeadsJob);

  // Nurture — once a day at 9am
  cron.schedule('0 9 * * *', runNurtureJob);

  console.log('All cron jobs started');
}

module.exports = { startJobs };
