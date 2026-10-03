import type { MailMessage } from './mail.service.js';

/** An email without its recipient - NotificationsService fills in `to`. */
export type EmailContent = Omit<MailMessage, 'to'>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/**
 * Shared layout. Inline styles only - most mail clients strip <style>.
 * `lines` are plain text (escaped here); the same lines make the text part.
 */
function layout(opts: { heading: string; lines: string[]; cta?: { label: string; url: string }; settingsUrl: string }): { html: string; text: string } {
  const body = opts.lines.map((line) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#374151">${escapeHtml(line)}</p>`).join('');
  const button = opts.cta
    ? `<p style="margin:20px 0"><a href="${escapeHtml(opts.cta.url)}" style="display:inline-block;background:#0d9488;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:10px">${escapeHtml(opts.cta.label)}</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:28px">
<tr><td>
<p style="margin:0 0 20px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#0d9488">SMARTJOURNEY</p>
<h1 style="margin:0 0 16px;font-size:20px;color:#111827">${escapeHtml(opts.heading)}</h1>
${body}${button}
<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#9ca3af">You're receiving this because email notifications are on in your SmartJourney settings. <a href="${escapeHtml(opts.settingsUrl)}" style="color:#9ca3af">Change notification settings</a></p>
</td></tr></table></td></tr></table></body></html>`;
  const text = [
    opts.heading,
    '',
    ...opts.lines,
    ...(opts.cta ? ['', `${opts.cta.label}: ${opts.cta.url}`] : []),
    '',
    `Change notification settings: ${opts.settingsUrl}`,
  ].join('\n');
  return { html, text };
}

/** Where the emails link back to. `appUrl` is the web app's origin. */
export function emailLinks(appUrl: string) {
  return {
    trip: (tripId: string) => `${appUrl}/saved-itineraries/${tripId}`,
    budget: `${appUrl}/budget-tracker`,
    settings: `${appUrl}/home?settings=notifications`,
  };
}

export function testEmail(appUrl: string): EmailContent {
  const links = emailLinks(appUrl);
  return {
    subject: 'SmartJourney email notifications are working',
    ...layout({
      heading: 'Email notifications are on',
      lines: [
        "This is a test message. From now on we'll email you about the things you've switched on: trip reminders, weather alerts and budget alerts.",
      ],
      settingsUrl: links.settings,
    }),
  };
}

export function tripSavedEmail(appUrl: string, trip: { id: string; title: string; startDate: Date | null; days: number }): EmailContent {
  const links = emailLinks(appUrl);
  const when = trip.startDate ? `It starts on ${formatDate(trip.startDate)}.` : 'Set your travel dates to get a reminder before you leave.';
  return {
    subject: `Trip saved: ${trip.title}`,
    ...layout({
      heading: `${trip.title} is saved`,
      lines: [`Your ${trip.days}-day itinerary is in Saved Itineraries.`, when],
      cta: { label: 'View itinerary', url: links.trip(trip.id) },
      settingsUrl: links.settings,
    }),
  };
}

export function tripReminderEmail(appUrl: string, trip: { id: string; title: string; startDate: Date; firstStop: string | null }): EmailContent {
  const links = emailLinks(appUrl);
  return {
    subject: `Reminder: ${trip.title} starts tomorrow`,
    ...layout({
      heading: `${trip.title} starts tomorrow`,
      lines: [
        `Your trip begins on ${formatDate(trip.startDate)}.`,
        ...(trip.firstStop ? [`First stop: ${trip.firstStop}.`] : []),
        'Check your day plan and budget before you set off.',
      ],
      cta: { label: 'Open day plan', url: links.trip(trip.id) },
      settingsUrl: links.settings,
    }),
  };
}

export interface RainyDay {
  date: Date;
  dayNumber: number;
  place: string;
  condition: string;
  rainChance: number;
}

/** One email per trip, listing every newly rainy day. */
export function weatherAlertEmail(appUrl: string, alert: { tripId: string; title: string; days: RainyDay[] }): EmailContent {
  const links = emailLinks(appUrl);
  const dayList = alert.days.map((d) => d.dayNumber).join(', ');
  const plural = alert.days.length > 1;
  return {
    subject: `Weather alert for ${alert.title}: rain likely on day${plural ? 's' : ''} ${dayList}`,
    ...layout({
      heading: `Rain likely during ${alert.title}`,
      lines: [
        ...alert.days.map(
          (d) =>
            `Day ${d.dayNumber} (${formatDate(d.date)}), ${d.place}: ${d.condition.toLowerCase()}, ${Math.round(d.rainChance * 100)}% chance of rain.`,
        ),
        'Consider moving outdoor activities or packing rain gear.',
      ],
      cta: { label: 'Review your itinerary', url: links.trip(alert.tripId) },
      settingsUrl: links.settings,
    }),
  };
}

export function budgetAlertEmail(
  appUrl: string,
  alert: { title: string; status: 'watch' | 'over_budget'; spent: number; budget: number; currency: string },
): EmailContent {
  const links = emailLinks(appUrl);
  const percent = Math.round((alert.spent / alert.budget) * 100);
  const over = alert.status === 'over_budget';
  return {
    subject: over ? `${alert.title} is over budget` : `${alert.title} has used ${percent}% of its budget`,
    ...layout({
      heading: over ? `${alert.title} is over budget` : `${alert.title} is nearing its budget`,
      lines: [
        `You've spent ${formatMoney(alert.spent, alert.currency)} of ${formatMoney(alert.budget, alert.currency)} (${percent}%).`,
        over
          ? `That's ${formatMoney(alert.spent - alert.budget, alert.currency)} over.`
          : `${formatMoney(alert.budget - alert.spent, alert.currency)} left.`,
      ],
      cta: { label: 'Open budget tracker', url: links.budget },
      settingsUrl: links.settings,
    }),
  };
}
