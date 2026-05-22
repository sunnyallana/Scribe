import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: ['../../.env', '../.env', '.env'], quiet: true });

import { parseCompileLog, type CompileLogEntry } from '@scribe/compiler-client';
import { type CompileLogStreamMessage, type ProjectId } from '@scribe/shared';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';

import { loadEnv } from '../config.js';
import { compileChannel, type CompileJobPayload } from '../services/compileQueue.js';
import { compileArtifactKey, COMPILE_ARTIFACTS_BUCKET, PROJECT_FILES_BUCKET } from '../services/storageService.js';

import type { Database } from '@scribe/shared';

const env = loadEnv();
const log = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

const supabase: SupabaseClient<Database> = createClient<Database>(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

async function publish(jobId: string, message: CompileLogStreamMessage): Promise<void> {
  await publisher.publish(compileChannel(jobId), JSON.stringify(message));
}

async function downloadProjectFiles(projectId: string, destDir: string): Promise<void> {
  const { data, error } = await supabase
    .from('project_files')
    .select('path, storage_key')
    .eq('project_id', projectId);
  if (error !== null) throw new Error(`failed to list files: ${error.message}`);

  for (const file of data) {
    const dl = await supabase.storage.from(PROJECT_FILES_BUCKET).download(file.storage_key);
    if (dl.error !== null || dl.data === null) {
      throw new Error(`failed to download ${file.path}: ${dl.error?.message ?? 'no data'}`);
    }
    const buf = Buffer.from(await dl.data.arrayBuffer());
    const dest = join(destDir, file.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
  }
}

interface CompileOutcome {
  readonly status: 'success' | 'error';
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

async function runTectonic(workdir: string, mainFile: string): Promise<CompileOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = ['--synctex', '--keep-logs', '--outdir', workdir, mainFile];
    const child = spawn(env.TECTONIC_BIN, args, { cwd: workdir });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, env.COMPILE_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        status: 'error',
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        durationMs: Date.now() - start,
      });
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({
        status: code === 0 ? 'success' : 'error',
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });
  });
}

async function uploadArtifact(
  projectId: string,
  jobId: string,
  filename: string,
  body: Buffer,
  contentType: string,
): Promise<string | null> {
  const key = compileArtifactKey(projectId as ProjectId, jobId, filename);
  const { error } = await supabase.storage
    .from(COMPILE_ARTIFACTS_BUCKET)
    .upload(key, body, { contentType, upsert: true });
  if (error !== null) {
    log.warn({ err: error, filename }, 'artifact upload failed');
    return null;
  }
  return key;
}

async function safeRead(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function runCompileJob(payload: CompileJobPayload): Promise<void> {
  const jobId = payload.compileJobId;
  log.info({ jobId, projectId: payload.projectId }, 'compile job started');

  await supabase
    .from('compile_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', jobId);
  await publish(jobId, { type: 'status', status: 'running' });

  const workdir = await mkdtemp(join(tmpdir(), `scribe-compile-${jobId}-`));
  let outcome: CompileOutcome;
  let entries: CompileLogEntry[] = [];
  let pdfKey: string | null = null;
  let logKey: string | null = null;
  let synctexKey: string | null = null;
  let errorMessage: string | null = null;

  try {
    await downloadProjectFiles(payload.projectId, workdir);
    outcome = await runTectonic(workdir, payload.mainFile);

    const combined = `${outcome.stdout}\n${outcome.stderr}`;
    entries = parseCompileLog(combined);

    // Stream entries to the channel.
    for (const entry of entries) {
      await publish(jobId, {
        type: 'log',
        entry: {
          level: entry.level === 'debug' ? 'info' : entry.level,
          message: entry.message,
          ...(entry.file !== undefined ? { file: entry.file } : {}),
          ...(entry.line !== undefined ? { line: entry.line } : {}),
          ...(entry.raw !== undefined ? { raw: entry.raw } : {}),
        },
      });
    }

    // Upload artifacts.
    const baseName = payload.mainFile.replace(/\.[^.]+$/, '');
    const pdfBuf = await safeRead(join(workdir, `${baseName}.pdf`));
    if (pdfBuf !== null) {
      pdfKey = await uploadArtifact(payload.projectId, jobId, 'output.pdf', pdfBuf, 'application/pdf');
    }
    const logBuf = await safeRead(join(workdir, `${baseName}.log`));
    if (logBuf !== null) {
      logKey = await uploadArtifact(
        payload.projectId,
        jobId,
        'compile.log',
        logBuf,
        'text/plain; charset=utf-8',
      );
    } else if (combined.trim().length > 0) {
      // Fall back to captured stdout/stderr.
      logKey = await uploadArtifact(
        payload.projectId,
        jobId,
        'compile.log',
        Buffer.from(combined, 'utf-8'),
        'text/plain; charset=utf-8',
      );
    }
    const synctexBuf = await safeRead(join(workdir, `${baseName}.synctex.gz`));
    if (synctexBuf !== null) {
      synctexKey = await uploadArtifact(
        payload.projectId,
        jobId,
        'main.synctex.gz',
        synctexBuf,
        'application/gzip',
      );
    }

    if (outcome.status === 'error') {
      const firstError = entries.find((e) => e.level === 'error');
      errorMessage = firstError?.message ?? `tectonic exited with code ${outcome.exitCode}`;
    }
  } catch (err) {
    outcome = {
      status: 'error',
      exitCode: -1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: 0,
    };
    errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err, jobId }, 'compile job failed');
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }

  await supabase
    .from('compile_jobs')
    .update({
      status: outcome.status,
      exit_code: outcome.exitCode,
      pdf_key: pdfKey,
      log_key: logKey,
      synctex_key: synctexKey,
      error_message: errorMessage,
      entries: entries.map((e) => ({
        level: e.level === 'debug' ? 'info' : e.level,
        message: e.message,
        ...(e.file !== undefined ? { file: e.file } : {}),
        ...(e.line !== undefined ? { line: e.line } : {}),
        ...(e.raw !== undefined ? { raw: e.raw } : {}),
      })),
      duration_ms: outcome.durationMs,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  await publish(jobId, {
    type: 'completed',
    status: outcome.status,
    pdfKey,
    logKey,
    synctexKey,
    durationMs: outcome.durationMs,
    errorMessage,
  });

  log.info({ jobId, status: outcome.status, durationMs: outcome.durationMs }, 'compile job done');
}

const worker = new Worker<CompileJobPayload>(
  env.COMPILE_QUEUE_NAME,
  async (job) => {
    await runCompileJob(job.data);
  },
  {
    connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
    concurrency: env.COMPILE_JOBS_CONCURRENT_PER_USER,
  },
);

worker.on('failed', (job, err) => {
  log.error({ err, jobId: job?.id }, 'worker job failed');
});

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'worker shutting down');
  await worker.close();
  await publisher.quit();
  process.exit(0);
};

process.on('SIGINT', (signal) => {
  void shutdown(signal);
});
process.on('SIGTERM', (signal) => {
  void shutdown(signal);
});

log.info({ queue: env.COMPILE_QUEUE_NAME }, 'compile worker started');
