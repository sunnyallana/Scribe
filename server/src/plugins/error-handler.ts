import fp from 'fastify-plugin';
import { ZodError } from 'zod';

import { type ServiceError, type ServiceErrorCode } from '@scribe/shared';

import type { FastifyPluginAsync } from 'fastify';

const STATUS_BY_CODE: Readonly<Record<ServiceErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  rate_limited: 429,
  invite_expired: 410,
  invite_consumed: 410,
  storage_failed: 500,
  email_failed: 500,
  internal: 500,
};

export function statusForServiceError(error: ServiceError): number {
  return STATUS_BY_CODE[error.code];
}

const errorHandlerPluginImpl: FastifyPluginAsync = (app) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        code: 'validation_failed',
        message: 'Request validation failed',
        details: error.flatten(),
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      code: 'internal',
      message: 'Internal server error',
    });
  });

  return Promise.resolve();
};

export const errorHandlerPlugin = fp(errorHandlerPluginImpl, {
  name: 'error-handler',
});
