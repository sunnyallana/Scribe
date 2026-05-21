import { type CompileLogStreamMessage } from '@scribe/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export interface CompileJobPayload {
  readonly compileJobId: string;
  readonly projectId: string;
  readonly mainFile: string;
  readonly engine: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';
  readonly triggeredBy: string | null;
}

export interface CompileQueueDeps {
  readonly redisUrl: string;
  readonly queueName: string;
}

/**
 * Channel used to fan out log lines and status updates from the worker to
 * any connected WebSocket clients tailing the job.
 */
export function compileChannel(compileJobId: string): string {
  return `compile:${compileJobId}`;
}

export function createCompileQueue({ redisUrl, queueName }: CompileQueueDeps) {
  // BullMQ requires `maxRetriesPerRequest: null` on the producer connection so
  // that blocking commands work in worker contexts. Using the same client for
  // the queue producer is fine; pub-sub clients are separate (Redis requires
  // subscriber sockets to be dedicated).
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<CompileJobPayload>(queueName, { connection });

  return {
    queue,
    connection,

    async enqueue(payload: CompileJobPayload): Promise<void> {
      await queue.add('compile', payload, {
        jobId: payload.compileJobId,
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 7 * 24 * 3600, count: 500 },
        attempts: 1,
      });
    },

    async publish(jobId: string, message: CompileLogStreamMessage): Promise<void> {
      await connection.publish(compileChannel(jobId), JSON.stringify(message));
    },

    /**
     * Open a dedicated subscriber. Caller is responsible for `unsubscribe()`
     * and `quit()` when done — typically when the WebSocket closes.
     */
    subscriber(): Redis {
      return new Redis(redisUrl, { maxRetriesPerRequest: null });
    },

    async close(): Promise<void> {
      await queue.close();
      await connection.quit();
    },
  };
}

export type CompileQueue = ReturnType<typeof createCompileQueue>;
