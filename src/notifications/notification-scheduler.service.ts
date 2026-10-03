import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { todayInSriLanka } from '../trips/trips.service.js';
import { tripReminderEmail, weatherAlertEmail, type RainyDay } from './notification-emails.js';
import { NotificationsService } from './notifications.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';
// OpenWeather's free /forecast covers ~5 days (same horizon the AI
// backend's orchestrator uses).
const FORECAST_HORIZON_DAYS = 5;
// pop (probability of precipitation) at or above this in any 3-hour slice
// of a trip day = worth an email. A judgment call, not from the SRS.
const RAIN_ALERT_POP = 0.6;

interface ForecastSlice {
  dt: number;
  pop?: number;
  weather?: { main: string; description: string }[];
}

/** YYYY-MM-DD of a unix time in Sri Lanka (UTC+5:30, no DST). */
function sriLankaDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000 + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Time-based notifications: "your trip starts tomorrow" and "rain is
 * forecast on day N". Runs once a day; notify()'s dedupe key makes a rerun
 * (or a restart) harmless.
 */
@Injectable()
export class NotificationSchedulerService {
  private readonly logger = new Logger(NotificationSchedulerService.name);
  private readonly weatherKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    this.weatherKey = config.get<string>('OPENWEATHER_API_KEY', '');
  }

  @Cron('0 7 * * *', { name: 'daily-notifications', timeZone: 'Asia/Colombo' })
  async runDaily() {
    const reminders = await this.sendTripReminders();
    const weather = await this.sendWeatherAlerts();
    this.logger.log(`Daily notifications: ${reminders} trip reminder(s), ${weather} weather alert(s) sent`);
    return { reminders, weather };
  }

  /** Trips that start tomorrow (Sri Lanka date). */
  async sendTripReminders(today: Date = todayInSriLanka()): Promise<number> {
    const tomorrow = new Date(today.getTime() + DAY_MS);
    const trips = await this.prisma.itinerary.findMany({
      where: {
        start_date: tomorrow,
        status: { not: 'past' },
        // Pre-filter to users who'd get it; notify() re-checks anyway.
        app_user: { is_active: true, notification_settings: { email_enabled: true, trip_reminders: true } },
      },
      select: {
        id: true,
        user_id: true,
        title: true,
        start_date: true,
        district: { select: { name: true } },
        itinerary_day: {
          where: { day_number: 1 },
          select: { itinerary_item: { orderBy: { order_index: 'asc' }, take: 1, select: { name: true } } },
        },
      },
    });

    let sent = 0;
    for (const trip of trips) {
      const title = trip.title ?? trip.district?.name ?? 'Your trip';
      const firstStop = trip.itinerary_day[0]?.itinerary_item[0]?.name ?? null;
      const ok = await this.notifications.notify(
        trip.user_id,
        'trip_reminder',
        `trip_reminder:${trip.id}:${ymd(tomorrow)}`,
        tripReminderEmail(this.notifications.appUrl, { id: trip.id, title, startDate: tomorrow, firstStop }),
      );
      if (ok) sent++;
    }
    return sent;
  }

  /** Trip days inside the forecast window with a high chance of rain. */
  async sendWeatherAlerts(today: Date = todayInSriLanka()): Promise<number> {
    if (!this.weatherKey) {
      this.logger.debug('OPENWEATHER_API_KEY not set - skipping weather alerts');
      return 0;
    }
    const horizon = new Date(today.getTime() + (FORECAST_HORIZON_DAYS - 1) * DAY_MS);
    const days = await this.prisma.itinerary_day.findMany({
      where: {
        date: { gte: today, lte: horizon },
        itinerary: {
          status: { not: 'past' },
          app_user: { is_active: true, notification_settings: { email_enabled: true, weather_alerts: true } },
        },
      },
      select: {
        date: true,
        day_number: true,
        itinerary: { select: { id: true, user_id: true, title: true, district: { select: { name: true } } } },
        // The day's first located stop stands in for "where you'll be".
        itinerary_item: {
          where: { latitude: { not: null }, longitude: { not: null } },
          orderBy: { order_index: 'asc' },
          take: 1,
          select: { name: true, latitude: true, longitude: true },
        },
      },
    });

    // One forecast per ~1 km cell per run, however many trips share it.
    const forecasts = new Map<string, Promise<ForecastSlice[] | null>>();
    const rainyByTrip = new Map<string, { userId: string; title: string; days: RainyDay[] }>();
    for (const day of days) {
      const stop = day.itinerary_item[0];
      if (!day.date || !stop || stop.latitude == null || stop.longitude == null) continue;
      const cell = `${stop.latitude.toFixed(2)},${stop.longitude.toFixed(2)}`;
      if (!forecasts.has(cell)) forecasts.set(cell, this.fetchForecast(stop.latitude, stop.longitude));
      const slices = await forecasts.get(cell)!;
      if (!slices) continue;

      const date = ymd(day.date);
      const wettest = slices
        .filter((s) => sriLankaDate(s.dt) === date)
        .reduce<ForecastSlice | null>((max, s) => ((s.pop ?? 0) > (max?.pop ?? -1) ? s : max), null);
      if (!wettest || (wettest.pop ?? 0) < RAIN_ALERT_POP) continue;

      const trip = day.itinerary;
      const entry = rainyByTrip.get(trip.id) ?? {
        userId: trip.user_id,
        title: trip.title ?? trip.district?.name ?? 'Your trip',
        days: [],
      };
      entry.days.push({
        date: day.date,
        dayNumber: day.day_number,
        place: stop.name,
        condition: wettest.weather?.[0]?.description ?? 'rain',
        rainChance: wettest.pop ?? 0,
      });
      rainyByTrip.set(trip.id, entry);
    }

    let sent = 0;
    for (const [tripId, trip] of rainyByTrip) {
      // Dedupe keys are `weather:<trip>:<date>+<date>...` - skip days an
      // earlier alert already covered, so a day is only ever mentioned once.
      const earlier = await this.prisma.notification.findMany({
        where: { user_id: trip.userId, dedupe_key: { startsWith: `weather:${tripId}:` } },
        select: { dedupe_key: true },
      });
      const covered = new Set(earlier.flatMap((n) => n.dedupe_key.split(':')[2]?.split('+') ?? []));
      const fresh = trip.days.filter((d) => !covered.has(ymd(d.date))).sort((a, b) => a.dayNumber - b.dayNumber);
      if (fresh.length === 0) continue;

      const ok = await this.notifications.notify(
        trip.userId,
        'weather_alert',
        `weather:${tripId}:${fresh.map((d) => ymd(d.date)).join('+')}`,
        weatherAlertEmail(this.notifications.appUrl, { tripId, title: trip.title, days: fresh }),
      );
      if (ok) sent++;
    }
    return sent;
  }

  private async fetchForecast(lat: number, lon: number): Promise<ForecastSlice[] | null> {
    try {
      const url = `${FORECAST_URL}?lat=${lat}&lon=${lon}&units=metric&appid=${encodeURIComponent(this.weatherKey)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { list?: ForecastSlice[] };
      return body.list ?? [];
    } catch (error) {
      this.logger.warn(`Forecast for ${lat},${lon} failed: ${(error as Error).message}`);
      return null;
    }
  }
}
