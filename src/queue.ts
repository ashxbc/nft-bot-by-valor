// Redis + BullMQ Precision Scheduling Queue
// Duplicate job prevention via unique taskId, per-user job isolation, and millisecond-exact T-0 triggers.

import { Queue, Job } from "bullmq";
import Redis, { RedisOptions } from "ioredis";
import { ArmedSnipe } from "./mint";

export interface SnipeJobPayload {
  taskId: string;
  userId: number;
  chatId: number;
  messageId: number;
  contractAddress: string;
  quantity: number;
  timingMode: string;
  targetTimeMs: number;
  rpcUrls: string[];
  armedSnipe: ArmedSnipe;
}

export const SNIPE_QUEUE_NAME = "seadrop-snipe-queue";

type JobProcessor = (payload: SnipeJobPayload) => Promise<any>;
let externalProcessor: JobProcessor | null = null;

export function registerJobProcessor(processor: JobProcessor) {
  externalProcessor = processor;
}

const REDIS_URL =
  process.env.REDIS_URL ||
  process.env.UPSTASH_REDIS_URL ||
  process.env.KV_URL ||
  "";

let redisConnection: Redis | null = null;
let snipeQueue: Queue<SnipeJobPayload> | null = null;
let isRedisAvailable = false;

// In-Memory Fallback Queue if Redis is not running
interface MemoryJob {
  id: string;
  data: SnipeJobPayload;
  targetTimeMs: number;
  timer: NodeJS.Timeout;
}
const memoryQueue = new Map<string, MemoryJob>();

export function getRedisConnection(): Redis | null {
  if (!REDIS_URL) {
    return null;
  }

  if (!redisConnection) {
    try {
      redisConnection = new Redis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
        retryStrategy: (times) => {
          if (times > 3) return null; // stop reconnecting if down
          return Math.min(times * 500, 2000);
        },
      });

      redisConnection.on("connect", () => {
        isRedisAvailable = true;
        console.log("✅ Connected to Redis (BullMQ Queue ready)");
      });

      redisConnection.on("error", () => {
        isRedisAvailable = false;
      });
    } catch {
      redisConnection = null;
    }
  }
  return redisConnection;
}

export function getSnipeQueue(): Queue<SnipeJobPayload> | null {
  if (!snipeQueue && REDIS_URL) {
    try {
      const conn = getRedisConnection();
      if (conn) {
        snipeQueue = new Queue<SnipeJobPayload>(SNIPE_QUEUE_NAME, {
          connection: conn,
          defaultJobOptions: {
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 100 },
            attempts: 1, // Worker handles retry attempts internally
          },
        });
      }
    } catch {
      snipeQueue = null;
    }
  }
  return snipeQueue;
}

/**
 * Enqueues a pre-signed snipe task for autonomous execution at exact T-0.
 * Sets `jobId: payload.taskId` to guarantee duplicate job prevention.
 */
export async function scheduleSnipeJob(
  payload: SnipeJobPayload,
): Promise<{ jobId: string; delayMs: number }> {
  const now = Date.now();
  const delayMs = Math.max(0, payload.targetTimeMs - now);

  const queue = getSnipeQueue();

  if (queue && isRedisAvailable) {
    try {
      const job = await queue.add("execute-snipe", payload, {
        jobId: payload.taskId, // Duplicate prevention
        delay: delayMs,
      });
      return { jobId: job.id || payload.taskId, delayMs };
    } catch (err: any) {
      console.warn("⚠️ BullMQ queue.add notice:", err.message);
    }
  }

  // In-Memory Fallback Queue (Precise millisecond timer)
  cancelMemoryJob(payload.taskId);

  const timer = setTimeout(async () => {
    memoryQueue.delete(payload.taskId);
    if (externalProcessor) {
      externalProcessor(payload).catch((err) => {
        console.error("Memory job execution error:", err.message);
      });
    }
  }, delayMs);

  if (timer.unref) timer.unref();

  memoryQueue.set(payload.taskId, {
    id: payload.taskId,
    data: payload,
    targetTimeMs: payload.targetTimeMs,
    timer,
  });

  return { jobId: payload.taskId, delayMs };
}

/**
 * Cancels a scheduled snipe job by task ID.
 */
export async function cancelSnipeJob(taskId: string): Promise<boolean> {
  let cancelled = false;

  const queue = getSnipeQueue();
  if (queue && isRedisAvailable) {
    try {
      const job = await queue.getJob(taskId);
      if (job) {
        await job.remove();
        cancelled = true;
      }
    } catch {}
  }

  if (cancelMemoryJob(taskId)) {
    cancelled = true;
  }

  return cancelled;
}

function cancelMemoryJob(taskId: string): boolean {
  const memJob = memoryQueue.get(taskId);
  if (memJob) {
    clearTimeout(memJob.timer);
    memoryQueue.delete(taskId);
    return true;
  }
  return false;
}

/**
 * Cancels all active scheduled jobs for a specific user ID.
 */
export async function cancelAllUserJobs(userId: number): Promise<number> {
  let count = 0;

  const queue = getSnipeQueue();
  if (queue && isRedisAvailable) {
    try {
      const delayed = await queue.getDelayed();
      for (const job of delayed) {
        if (job.data.userId === userId) {
          await job.remove();
          count++;
        }
      }
    } catch {}
  }

  for (const [id, memJob] of memoryQueue.entries()) {
    if (memJob.data.userId === userId) {
      clearTimeout(memJob.timer);
      memoryQueue.delete(id);
      count++;
    }
  }

  return count;
}
