// --------------------------------------------------------
// Timezone-aware time math for the follow-up SMS timing rule.
// Uses Node's built-in Intl.DateTimeFormat with an IANA timezone string
// — correctly handles daylight saving without adding a date library
// dependency (deliberate, given the deployment friction already hit
// getting packages installed in this environment).
// --------------------------------------------------------

const DEFAULT_SETTINGS = {
  sms_morning_cutoff_hour: 11,   // before this hour = "morning" bucket
  sms_evening_cutoff_hour: 15,   // from this hour onward = "evening" bucket
  sms_same_day_delay_hours: 3,   // the in-between bucket: send N hours later, same day
  sms_after_morning_time: '18:00',  // morning-bucket calls get evening SMS at this time
  sms_after_evening_time: '10:30',  // evening-bucket calls get next-morning SMS at this time
  max_hot_attempts: 4,
  nurture_intervals_days: [7, 7, 7, 14, 30, 30],

  // DEMO MODE — replaces the old per-injection "demo" checkbox. When true,
  // EVERY lead created for this client (manually injected OR arriving for
  // real via /webhook/meta) goes through the demo web-call simulator path
  // instead of dialing a real phone. Flip off before going live for real.
  demo_mode: false,
  // How long the simulator waits after a lead is queued before it actually
  // rings — gives you time to get the phone screen open/visible.
  demo_call_delay_seconds: 5,
};

function mergeSettings(clientSettings) {
  return { ...DEFAULT_SETTINGS, ...(clientSettings || {}) };
}

// Returns the hour (0-23) and minute of a UTC Date, as seen in the given
// IANA timezone. This is the building block everything else uses.
function getLocalHourMinute(utcDate, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(utcDate);
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return { hour: hour === 24 ? 0 : hour, minute };
}

// Returns the y/m/d of a UTC Date as seen in the given timezone — needed
// so "next business day" means the next day in THEIR timezone, not UTC's.
function getLocalDateParts(utcDate, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(utcDate);
  return {
    year: parseInt(parts.find(p => p.type === 'year').value, 10),
    month: parseInt(parts.find(p => p.type === 'month').value, 10),
    day: parseInt(parts.find(p => p.type === 'day').value, 10),
  };
}

// Builds a real UTC Date that corresponds to a specific local wall-clock
// time (hour:minute, on a given y/m/d) in the given timezone. This has to
// account for the timezone's current UTC offset — found by comparing a
// guess against what Intl reports back, then correcting once. Good
// enough for scheduling purposes (no DST-transition-instant edge case
// matters here — we're scheduling hours/days out, not to the second).
function localTimeToUtc(year, month, day, hour, minute, timezone) {
  // First guess: treat the wall-clock time as if it were UTC, then see
  // what that instant actually reads as in the target timezone, and
  // correct by the difference.
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const seen = getLocalHourMinute(guess, timezone);
  const seenDateParts = getLocalDateParts(guess, timezone);

  const seenAsMinutes = (seenDateParts.day - day) * 24 * 60 + seen.hour * 60 + seen.minute;
  const wantedAsMinutes = hour * 60 + minute;
  const diffMinutes = wantedAsMinutes - seenAsMinutes;

  return new Date(guess.getTime() + diffMinutes * 60 * 1000);
}

// --------------------------------------------------------
// THE ACTUAL RULE
//
// Given when a call was answered (UTC) and the client's business
// timezone + settings, return:
//   - which bucket it fell into ('morning' | 'midday' | 'evening')
//   - the UTC Date the follow-up SMS should be sent at
//   - which message variant to use ('morning' | 'evening')
// --------------------------------------------------------
function computeSmsSendTime(answeredAtUtc, timezone, settings) {
  const s = mergeSettings(settings);
  const { hour, minute } = getLocalHourMinute(answeredAtUtc, timezone);
  const { year, month, day } = getLocalDateParts(answeredAtUtc, timezone);

  // Bucket 1 — before morning cutoff (e.g. < 11:00) → same day evening
  if (hour < s.sms_morning_cutoff_hour) {
    const [h, m] = s.sms_after_morning_time.split(':').map(Number);
    return {
      bucket: 'morning',
      variant: 'evening', // the SMS itself uses evening-toned wording, since it's sent in the evening
      sendAt: localTimeToUtc(year, month, day, h, m, timezone),
    };
  }

  // Bucket 2 — evening cutoff and later (e.g. >= 15:00) → next morning
  if (hour >= s.sms_evening_cutoff_hour) {
    const [h, m] = s.sms_after_evening_time.split(':').map(Number);
    // next calendar day in their timezone
    const nextDayUtcNoon = localTimeToUtc(year, month, day, 12, 0, timezone);
    const nextDayParts = getLocalDateParts(new Date(nextDayUtcNoon.getTime() + 24 * 60 * 60 * 1000), timezone);
    return {
      bucket: 'evening',
      variant: 'morning', // sent the next morning, so morning-toned wording
      sendAt: localTimeToUtc(nextDayParts.year, nextDayParts.month, nextDayParts.day, h, m, timezone),
    };
  }

  // Bucket 3 — the gap in between (e.g. 11:00-15:00) → same day, N hours later
  return {
    bucket: 'midday',
    variant: 'evening', // still later the same day — evening-toned reads more naturally than "morning"
    sendAt: new Date(answeredAtUtc.getTime() + s.sms_same_day_delay_hours * 60 * 60 * 1000),
  };
}

// --------------------------------------------------------
// EDGE CASE — missed cron window
// If a scheduled send time has already passed by the time the cron job
// actually checks it, decide whether to send late, or skip rather than
// send something stale and oddly timed.
// --------------------------------------------------------
function lateSendDecision(scheduledForUtc, nowUtc = new Date()) {
  const lateByMs = nowUtc.getTime() - scheduledForUtc.getTime();
  const lateByHours = lateByMs / (60 * 60 * 1000);

  if (lateByHours <= 2) return { action: 'send' };               // close enough, send now
  if (lateByHours <= 12) return { action: 'send_late' };          // noticeably late but still same-ish window, send anyway
  return { action: 'skip', reason: `Missed send window by ${Math.round(lateByHours)}h` };
}

module.exports = {
  DEFAULT_SETTINGS,
  mergeSettings,
  getLocalHourMinute,
  getLocalDateParts,
  localTimeToUtc,
  computeSmsSendTime,
  lateSendDecision,
};
