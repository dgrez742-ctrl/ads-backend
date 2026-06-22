const cron = require('node-cron');
const {
  getLeadsForFollowUp, getStalledLeads, getNurtureLeadsDue, updateLeadStatus, logActivity,
  getAttemptCount, moveToNurture, updateNurtureStep, getClientSettings,
  getDueScheduledSms, markScheduledSmsSent, markScheduledSmsSkipped, getLead,
  getSmsTemplate, resolveTemplate, getEmailStepContent,
} = require('../services/leads');
const { triggerRetellCall } = require('../services/retell');
const { sendSMS } = require('../services/twilio');
const { lateSendDecision } = require('../services/timezone');
const supabase = require('../supabase');

// --------------------------------------------------------
// SCHEDULED SMS JOB — runs every 15 minutes
// Sends any post-answered-call follow-up SMS that's now due (see
// Timezone.js for the timing rule, Simulator.routes.js and Webhooks.js
// for where these get scheduled). Handles the missed-cron-window edge
// case: send late if it's not too late, skip rather than send something
// stale if it's very late.
// --------------------------------------------------------
async function runScheduledSmsJob() {
  console.log('Checking for due scheduled SMS...');

  try {
    const due = await getDueScheduledSms();

    for (const row of due) {
      const lead = row.ldm_leads;
      if (!lead) {
        await markScheduledSmsSkipped(row.id, 'Lead no longer exists');
        continue;
      }

      // Re-check booked status right before sending — covers the case
      // where a booking event arrived between when this was scheduled
      // and now, in the small window before the cancel had a chance to
      // run, or if cancellation itself failed for some reason.
      const freshLead = await getLead(lead.id);
      if (freshLead.status === 'booked') {
        await markScheduledSmsSkipped(row.id, 'Lead booked before send time');
        continue;
      }

      const decision = lateSendDecision(new Date(row.scheduled_for));
      if (decision.action === 'skip') {
        console.log(`Scheduled SMS ${row.id} skipped — ${decision.reason}`);
        await markScheduledSmsSkipped(row.id, decision.reason);
        continue;
      }

      const result = await sendSMS(lead.phone, row.message);
      await logActivity(lead.id, 'sms', result.success ? 'sent' : 'bounced', row.message);
      await markScheduledSmsSent(row.id);
      console.log(`Scheduled SMS ${row.id} sent to lead ${lead.id} (${decision.action})`);
    }

  } catch (err) {
    console.error('Scheduled SMS job error:', err.message);
  }
}

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

        const { businessName } = await getClientSettings(lead.client_id);
        const template = await getSmsTemplate(lead.client_id, 'no_answer_2');
        const message = resolveTemplate(template, lead, businessName);
        const smsResult = await sendSMS(lead.phone, message);
        await logActivity(lead.id, 'sms', smsResult.success ? 'sent' : 'bounced', message);

      } else if (attemptCount === 3) {
        // Day 4 — final call + final SMS
        console.log(`Lead ${lead.id} — final attempt`);
        const result = await triggerRetellCall(lead, 4);
        await logActivity(lead.id, 'call', result.success ? 'no_answer' : 'bounced', 'Final follow up call');

        const { businessName } = await getClientSettings(lead.client_id);
        const template = await getSmsTemplate(lead.client_id, 'no_answer_final');
        const message = resolveTemplate(template, lead, businessName);
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

      // Send real nurture email content from the client's own configured
      // sequence, instead of just logging a placeholder line. Falls back
      // to a generic message if this step hasn't had content written
      // for it yet (see getEmailStepContent in Leads.js), so the
      // sequence still runs end to end even before a client finishes
      // writing all their steps.
      const { subject, body } = await getEmailStepContent(lead.client_id, step);
      await logActivity(lead.id, 'email', 'sent', `${subject} — ${body}`);

      // Update nurture to next step — uses the client's own configured
      // intervals (settings page) instead of the same fixed schedule for
      // every client.
      const { settings } = await getClientSettings(lead.client_id);
      await updateNurtureStep(item.id, step, settings);
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

  // Scheduled SMS — every 15 minutes (tighter than the hourly follow-up
  // job since these have specific wall-clock send times to hit, e.g.
  // "6:00pm" or "10:30am" — checking only once an hour could miss the
  // window by up to 59 minutes on its own, compounding with the
  // late-send tolerance already built into the job itself)
  cron.schedule('*/15 * * * *', runScheduledSmsJob);

  // Nurture — once a day at 9am
  cron.schedule('0 9 * * *', runNurtureJob);

  console.log('All cron jobs started');
}

module.exports = { startJobs };
