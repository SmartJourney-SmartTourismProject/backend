import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailService } from './mail.service.js';
import { budgetAlertEmail, testEmail, tripSavedEmail, type EmailContent } from './notification-emails.js';
import { UpdateNotificationSettingsDto } from './dto/update-notification-settings.dto.js';

/** notification.type values (0018_notifications.sql CHECK constraint). */
export type NotificationType = 'trip_reminder' | 'trip_saved' | 'weather_alert' | 'budget_alert' | 'test';

const SETTINGS_SELECT = {
  trip_reminders: true,
  weather_alerts: true,
  budget_alerts: true,
  push_enabled: true,
  email_enabled: true,
  sound_enabled: true,
  sound_volume: true,
  updated_at: true,
} as const;

type Settings = {
  trip_reminders: boolean;
  weather_alerts: boolean;
  budget_alerts: boolean;
  push_enabled: boolean;
  email_enabled: boolean;
  sound_enabled: boolean;
  sound_volume: number;
  updated_at: Date | null;
};

// Mirrors the column defaults - what a user with no row gets.
const DEFAULT_SETTINGS: Settings = {
  trip_reminders: true,
  weather_alerts: true,
  budget_alerts: true,
  push_enabled: true,
  email_enabled: false,
  sound_enabled: true,
  sound_volume: 65,
  updated_at: null,
};

/** Which per-type switch gates each notification type. `test` has none -
 * the user asked for it explicitly. */
const TYPE_SWITCH: Record<NotificationType, keyof Settings | null> = {
  trip_reminder: 'trip_reminders',
  trip_saved: 'trip_reminders',
  weather_alert: 'weather_alerts',
  budget_alert: 'budget_alerts',
  test: null,
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

/**
 * Email notifications. Every event goes through notify(), which emails the
 * trip's owner only if they turned email on AND the switch for that kind of
 * event is on, and only once per dedupe key.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  /** The web app's origin, for links in emails. FRONTEND_URL may list
   * several (CORS); the first is the canonical one. */
  readonly appUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    config: ConfigService,
  ) {
    this.appUrl = (config.get<string>('FRONTEND_URL', 'http://localhost:3000').split(',')[0] ?? '').trim().replace(/\/$/, '');
  }

  // ---- /users/me/notification-settings ------------------------------------

  async getSettings(userId: string): Promise<Settings> {
    const row = await this.prisma.notification_settings.findUnique({
      where: { user_id: userId },
      select: SETTINGS_SELECT,
    });
    return row ?? DEFAULT_SETTINGS;
  }

  async updateSettings(userId: string, dto: UpdateNotificationSettingsDto): Promise<Settings> {
    const data = { ...dto, updated_at: new Date() };
    return this.prisma.notification_settings.upsert({
      where: { user_id: userId },
      create: { user_id: userId, ...data },
      update: data,
      select: SETTINGS_SELECT,
    });
  }

  /** "Send test email" - not deduped, but refused while email is off so the
   * button can't be used to mail someone who opted out. */
  async sendTest(userId: string) {
    const settings = await this.getSettings(userId);
    if (!settings.email_enabled) {
      throw new BadRequestException('Turn on email notifications first.');
    }
    const user = await this.prisma.app_user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) throw new BadRequestException('User not found');
    try {
      await this.mail.send({ to: user.email, ...testEmail(this.appUrl) });
    } catch (error) {
      this.logger.error(`Test email to ${user.email} failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Could not send the email. Try again later.');
    }
    return { sent: true, to: user.email };
  }

  // ---- delivery ------------------------------------------------------------

  /**
   * Emails `userId` if their settings allow `type`. Returns whether an email
   * went out. Never throws - a notification failing must not fail the
   * request (saving a trip, adding an expense) that triggered it.
   */
  async notify(userId: string, type: NotificationType, dedupeKey: string, content: EmailContent): Promise<boolean> {
    try {
      const user = await this.prisma.app_user.findUnique({
        where: { id: userId },
        select: { email: true, is_active: true, notification_settings: { select: SETTINGS_SELECT } },
      });
      if (!user?.is_active) return false;
      const settings = user.notification_settings ?? DEFAULT_SETTINGS;
      const typeSwitch = TYPE_SWITCH[type];
      if (!settings.email_enabled || (typeSwitch && !settings[typeSwitch])) return false;

      // Claim the dedupe key BEFORE sending, so two concurrent triggers
      // (two quick expense edits) can't both send.
      let logId: string;
      try {
        const log = await this.prisma.notification.create({
          data: { user_id: userId, type, channel: 'email', dedupe_key: dedupeKey, subject: content.subject },
          select: { id: true },
        });
        logId = log.id;
      } catch (error) {
        if (isUniqueViolation(error)) return false; // already sent
        throw error;
      }

      try {
        await this.mail.send({ to: user.email, ...content });
        return true;
      } catch (error) {
        // Release the key so the next trigger / scheduler run retries.
        await this.prisma.notification.delete({ where: { id: logId } }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      this.logger.error(`Notification ${type} (${dedupeKey}) for user ${userId} failed: ${(error as Error).message}`);
      return false;
    }
  }

  // ---- event hooks (called by other modules, fire-and-forget) ------------

  async tripSaved(userId: string, trip: { id: string; title: string | null; start_date: Date | null; days: number }) {
    const title = trip.title ?? 'Your trip';
    return this.notify(
      userId,
      'trip_saved',
      `trip_saved:${trip.id}`,
      tripSavedEmail(this.appUrl, { id: trip.id, title, startDate: trip.start_date, days: trip.days }),
    );
  }

  /** Called after an expense changes. One email per trip per status, so
   * crossing 80% and later going over each send once. */
  async budgetChanged(
    userId: string,
    trip: { id: string; title: string; status: string; spent: number; budget: number | null; currency: string },
  ) {
    if ((trip.status !== 'watch' && trip.status !== 'over_budget') || trip.budget == null) return false;
    return this.notify(
      userId,
      'budget_alert',
      `budget:${trip.id}:${trip.status}`,
      budgetAlertEmail(this.appUrl, {
        title: trip.title,
        status: trip.status,
        spent: trip.spent,
        budget: trip.budget,
        currency: trip.currency,
      }),
    );
  }
}
