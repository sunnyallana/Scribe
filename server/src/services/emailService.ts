import nodemailer, { type Transporter } from 'nodemailer';

import { err, ok, type Result, serviceError, type ServiceError } from '@scribe/shared';

import type { Env } from '../config.js';

export interface EmailServiceLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface EmailServiceDeps {
  env: Env;
  logger: EmailServiceLogger;
}

export interface InviteEmailInput {
  readonly to: string;
  readonly inviterDisplayName: string | null;
  readonly projectName: string;
  readonly role: string;
  readonly acceptUrl: string;
  readonly expiresAt: string;
}

function buildTransporter(env: Env): Transporter {
  if (env.SMTP_HOST !== undefined) {
    return nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth:
        env.SMTP_USER !== undefined && env.SMTP_PASS !== undefined
          ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
          : undefined,
    });
  }
  return nodemailer.createTransport({
    jsonTransport: true,
  });
}

function renderInviteEmail(input: InviteEmailInput): { html: string; text: string } {
  const inviter = input.inviterDisplayName ?? 'A collaborator';
  const text = `${inviter} invited you to collaborate on "${input.projectName}" as ${input.role}.

Accept the invitation: ${input.acceptUrl}

This link expires on ${input.expiresAt}.`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Scribe invitation</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 40px auto; color: #1a1a1a;">
  <h1 style="font-size: 22px; font-weight: 600;">You've been invited to Scribe</h1>
  <p><strong>${escapeHtml(inviter)}</strong> invited you to collaborate on
  <strong>${escapeHtml(input.projectName)}</strong> as <em>${escapeHtml(input.role)}</em>.</p>
  <p style="margin: 32px 0;">
    <a href="${escapeHtml(input.acceptUrl)}"
       style="background: #18181b; color: #fafafa; padding: 12px 20px; border-radius: 6px;
              text-decoration: none; font-weight: 500;">
      Accept invitation
    </a>
  </p>
  <p style="color: #71717a; font-size: 13px;">This link expires on ${escapeHtml(input.expiresAt)}.
  If you didn't expect this, you can ignore the email.</p>
</body></html>`;

  return { html, text };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createEmailService({ env, logger }: EmailServiceDeps) {
  const transporter = buildTransporter(env);

  return {
    async sendInvite(input: InviteEmailInput): Promise<Result<void, ServiceError>> {
      const { html, text } = renderInviteEmail(input);
      try {
        await transporter.sendMail({
          from: env.SMTP_FROM,
          to: input.to,
          subject: `${input.inviterDisplayName ?? 'A collaborator'} invited you to ${input.projectName}`,
          html,
          text,
        });
        if (env.SMTP_HOST === undefined) {
          logger.info(
            { to: input.to, acceptUrl: input.acceptUrl },
            'invite email rendered (no SMTP configured — link logged for dev)',
          );
        }
        return ok(undefined);
      } catch (cause) {
        logger.error({ err: cause, to: input.to }, 'failed to send invite email');
        return err(
          serviceError('email_failed', cause instanceof Error ? cause.message : 'send failed'),
        );
      }
    },
  };
}

export type EmailService = ReturnType<typeof createEmailService>;
