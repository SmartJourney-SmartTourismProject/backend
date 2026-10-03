import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Outgoing SMTP for app notifications. Same mail server Keycloak uses for
 * password resets (KC_SMTP_*), but its own MAIL_* settings: locally the
 * backend runs on the host, so it reaches mailpit at localhost:1025, not at
 * the `mailpit` hostname Keycloak sees inside the compose network.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const user = this.config.get<string>('MAIL_USER');
    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('MAIL_HOST', 'localhost'),
      port: Number(this.config.get<string>('MAIL_PORT', '1025')),
      // true = implicit TLS (port 465); false = plain, upgraded via STARTTLS
      // when the server offers it (587).
      secure: this.config.get<string>('MAIL_SECURE', 'false') === 'true',
      ...(user && { auth: { user, pass: this.config.get<string>('MAIL_PASSWORD', '') } }),
    });
    this.from = this.config.get<string>('MAIL_FROM', 'SmartJourney <noreply@smartjourney.local>');
  }

  /** Throws on failure - the caller decides whether that matters. */
  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.from, ...message });
    this.logger.log(`Sent "${message.subject}" to ${message.to}`);
  }
}
