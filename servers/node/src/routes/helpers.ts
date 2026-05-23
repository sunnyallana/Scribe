import { type Result, type ServiceError } from '@scribe/shared';

import { statusForServiceError } from '../plugins/error-handler.js';

import type { FastifyReply } from 'fastify';

export async function sendResult<T>(
  reply: FastifyReply,
  result: Result<T, ServiceError>,
): Promise<T | FastifyReply> {
  if (result.ok) return result.value;
  return reply.code(statusForServiceError(result.error)).send({
    code: result.error.code,
    message: result.error.message,
    details: result.error.details,
  });
}
