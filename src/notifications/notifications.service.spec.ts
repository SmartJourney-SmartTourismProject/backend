import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MailService } from './mail.service.js';
import { NotificationsService } from './notifications.service.js';

const CONTENT = { subject: 'Hello', text: 'hi', html: '<p>hi</p>' };
const ON = { trip_reminders: true, weather_alerts: true, budget_alerts: true, push_enabled: true, email_enabled: true, sound_enabled: true, sound_volume: 65, updated_at: new Date() };

function setup(user: unknown) {
  const prisma = {
    app_user: { findUnique: vi.fn().mockResolvedValue(user) },
    notification: { create: vi.fn().mockResolvedValue({ id: 'log-1' }), delete: vi.fn().mockResolvedValue({}) },
    notification_settings: { findUnique: vi.fn(), upsert: vi.fn() },
  };
  const mail = { send: vi.fn().mockResolvedValue(undefined) };
  const config = { get: (_key: string, fallback: string) => (_key === 'FRONTEND_URL' ? 'https://app.example, http://localhost:3000' : fallback) };
  const service = new NotificationsService(
    prisma as unknown as PrismaService,
    mail as unknown as MailService,
    config as unknown as ConfigService,
  );
  return { prisma, mail, service };
}

describe('NotificationsService.notify', () => {
  it('emails the user and logs the dedupe key when email and the type switch are on', async () => {
    const { prisma, mail, service } = setup({ email: 'a@b.c', is_active: true, notification_settings: ON });

    await expect(service.notify('u1', 'budget_alert', 'budget:t1:watch', CONTENT)).resolves.toBe(true);

    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ user_id: 'u1', dedupe_key: 'budget:t1:watch', type: 'budget_alert' }) }),
    );
    expect(mail.send).toHaveBeenCalledWith({ to: 'a@b.c', ...CONTENT });
  });

  it('sends nothing when the user has no settings row (email defaults to off)', async () => {
    const { mail, service } = setup({ email: 'a@b.c', is_active: true, notification_settings: null });
    await expect(service.notify('u1', 'trip_reminder', 'k', CONTENT)).resolves.toBe(false);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("respects the per-type switch even when email is on", async () => {
    const { mail, service } = setup({ email: 'a@b.c', is_active: true, notification_settings: { ...ON, weather_alerts: false } });
    await expect(service.notify('u1', 'weather_alert', 'k', CONTENT)).resolves.toBe(false);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('skips deactivated accounts', async () => {
    const { mail, service } = setup({ email: 'a@b.c', is_active: false, notification_settings: ON });
    await expect(service.notify('u1', 'budget_alert', 'k', CONTENT)).resolves.toBe(false);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('does not send twice for the same dedupe key', async () => {
    const { prisma, mail, service } = setup({ email: 'a@b.c', is_active: true, notification_settings: ON });
    prisma.notification.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(service.notify('u1', 'budget_alert', 'k', CONTENT)).resolves.toBe(false);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('releases the dedupe key when sending fails, and never throws', async () => {
    const { prisma, mail, service } = setup({ email: 'a@b.c', is_active: true, notification_settings: ON });
    mail.send.mockRejectedValue(new Error('SMTP down'));
    await expect(service.notify('u1', 'budget_alert', 'k', CONTENT)).resolves.toBe(false);
    expect(prisma.notification.delete).toHaveBeenCalledWith({ where: { id: 'log-1' } });
  });
});

describe('NotificationsService.budgetChanged', () => {
  it('only alerts for watch / over_budget trips that have a budget', async () => {
    const { mail, service } = setup({ email: 'a@b.c', is_active: true, notification_settings: ON });
    const trip = { id: 't1', title: 'Kandy', spent: 500, budget: 1000, currency: 'LKR' };

    await expect(service.budgetChanged('u1', { ...trip, status: 'on_track' })).resolves.toBe(false);
    await expect(service.budgetChanged('u1', { ...trip, status: 'watch', budget: null })).resolves.toBe(false);
    expect(mail.send).not.toHaveBeenCalled();

    await expect(service.budgetChanged('u1', { ...trip, status: 'over_budget', spent: 1200 })).resolves.toBe(true);
    expect(mail.send.mock.calls[0][0].subject).toBe('Kandy is over budget');
  });
});

describe('NotificationsService.sendTest', () => {
  it('refuses while email notifications are off', async () => {
    const { prisma, mail, service } = setup({ email: 'a@b.c' });
    prisma.notification_settings.findUnique.mockResolvedValue(null);
    await expect(service.sendTest('u1')).rejects.toThrow(BadRequestException);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('links back to the first FRONTEND_URL', async () => {
    const { prisma, mail, service } = setup({ email: 'a@b.c' });
    prisma.notification_settings.findUnique.mockResolvedValue(ON);
    await expect(service.sendTest('u1')).resolves.toEqual({ sent: true, to: 'a@b.c' });
    expect(mail.send.mock.calls[0][0].html).toContain('https://app.example/home?settings=notifications');
  });
});
