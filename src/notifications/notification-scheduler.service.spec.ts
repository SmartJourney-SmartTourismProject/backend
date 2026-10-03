import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service.js';
import { NotificationSchedulerService } from './notification-scheduler.service.js';
import type { NotificationsService } from './notifications.service.js';

const TODAY = new Date('2026-10-03T00:00:00Z');

function setup({ weatherKey = 'key' } = {}) {
  const prisma = {
    itinerary: { findMany: vi.fn().mockResolvedValue([]) },
    itinerary_day: { findMany: vi.fn().mockResolvedValue([]) },
    notification: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const notifications = { notify: vi.fn().mockResolvedValue(true), appUrl: 'http://localhost:3000' };
  const config = { get: (key: string, fallback: string) => (key === 'OPENWEATHER_API_KEY' ? weatherKey : fallback) };
  const service = new NotificationSchedulerService(
    prisma as unknown as PrismaService,
    notifications as unknown as NotificationsService,
    config as unknown as ConfigService,
  );
  return { prisma, notifications, service };
}

afterEach(() => vi.unstubAllGlobals());

describe('NotificationSchedulerService.sendTripReminders', () => {
  it('reminds owners of trips starting tomorrow, once per trip and date', async () => {
    const { prisma, notifications, service } = setup();
    prisma.itinerary.findMany.mockResolvedValue([
      {
        id: 't1',
        user_id: 'u1',
        title: null,
        start_date: new Date('2026-10-04'),
        district: { name: 'Kandy' },
        itinerary_day: [{ itinerary_item: [{ name: 'Temple of the Tooth' }] }],
      },
    ]);

    await expect(service.sendTripReminders(TODAY)).resolves.toBe(1);

    expect(prisma.itinerary.findMany.mock.calls[0][0].where.start_date).toEqual(new Date('2026-10-04T00:00:00Z'));
    const [userId, type, key, content] = notifications.notify.mock.calls[0];
    expect([userId, type, key]).toEqual(['u1', 'trip_reminder', 'trip_reminder:t1:2026-10-04']);
    expect(content.subject).toBe('Reminder: Kandy starts tomorrow');
    expect(content.text).toContain('First stop: Temple of the Tooth.');
  });
});

describe('NotificationSchedulerService.sendWeatherAlerts', () => {
  const day = (date: string) => ({
    date: new Date(date),
    day_number: 2,
    itinerary: { id: 't1', user_id: 'u1', title: 'Ella escape', district: null },
    itinerary_item: [{ name: 'Nine Arch Bridge', latitude: 6.8768, longitude: 81.0608 }],
  });
  // 2026-10-05 06:00 Sri Lanka = 00:30 UTC
  const slice = (pop: number) => ({ dt: Date.UTC(2026, 9, 5, 0, 30) / 1000, pop, weather: [{ main: 'Rain', description: 'Moderate rain' }] });

  it('alerts when a trip day has a high chance of rain', async () => {
    const { prisma, notifications, service } = setup();
    prisma.itinerary_day.findMany.mockResolvedValue([day('2026-10-05')]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ list: [slice(0.85)] }) }));

    await expect(service.sendWeatherAlerts(TODAY)).resolves.toBe(1);
    const [, type, key, content] = notifications.notify.mock.calls[0];
    expect([type, key]).toEqual(['weather_alert', 'weather:t1:2026-10-05']);
    expect(content.text).toContain('85% chance of rain');
  });

  it('sends one email per trip for several rainy days, skipping days already alerted', async () => {
    const { prisma, notifications, service } = setup();
    prisma.itinerary_day.findMany.mockResolvedValue([
      { ...day('2026-10-05'), day_number: 2 },
      { ...day('2026-10-06'), day_number: 3 },
      { ...day('2026-10-07'), day_number: 4 },
    ]);
    prisma.notification.findMany.mockResolvedValue([{ dedupe_key: 'weather:t1:2026-10-05' }]);
    const wet = (d: number) => ({ dt: Date.UTC(2026, 9, d, 6) / 1000, pop: 0.9, weather: [{ main: 'Rain', description: 'Heavy rain' }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ list: [wet(5), wet(6), wet(7)] }) }));

    await expect(service.sendWeatherAlerts(TODAY)).resolves.toBe(1);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    const [, , key, content] = notifications.notify.mock.calls[0];
    expect(key).toBe('weather:t1:2026-10-06+2026-10-07');
    expect(content.subject).toBe('Weather alert for Ella escape: rain likely on days 3, 4');
  });

  it('stays quiet for a low chance of rain', async () => {
    const { prisma, notifications, service } = setup();
    prisma.itinerary_day.findMany.mockResolvedValue([day('2026-10-05')]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ list: [slice(0.2)] }) }));

    await expect(service.sendWeatherAlerts(TODAY)).resolves.toBe(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('does nothing without an OpenWeather key', async () => {
    const { prisma, service } = setup({ weatherKey: '' });
    await expect(service.sendWeatherAlerts(TODAY)).resolves.toBe(0);
    expect(prisma.itinerary_day.findMany).not.toHaveBeenCalled();
  });
});
