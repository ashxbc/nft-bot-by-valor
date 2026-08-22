// Persistent Node.js Worker Process for T-0 Autonomous Execution
// Listens to BullMQ queue, maintains warm RPC sockets, executes pre-signed byte blasts,
// runs 200ms receipt confirmation polling, pushes real-time Telegram updates, and updates Supabase.

import { Worker, Job } from "bullmq";
import {
  executeArmedSnipe,
  warmRpcConnections,
  SnipeExecutionReport,
} from "./mint";
import { updateMintTask, logActivity, getUser, decryptSensitive } from "./db";
import {
  SnipeJobPayload,
  SNIPE_QUEUE_NAME,
  getRedisConnection,
  registerJobProcessor,
} from "./queue";
import { bot } from "./bot";
import {
  esc,
  code,
  link,
  getMainMenuKeyboard,
  getLiveExecutionKeyboard,
} from "./menu";

let snipeWorker: Worker<SnipeJobPayload> | null = null;

/**
 * Updates a Telegram live message card safely.
 */
async function updateCard(
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: any,
) {
  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      parse_mode: "HTML",
      reply_markup: replyMarkup,
      link_preview_options: { is_disabled: true },
    });
  } catch (err: any) {
    if (!err.message?.includes("message is not modified")) {
      // Silently ignore non-modified stream updates
    }
  }
}

/**
 * Core processor for an autonomous snipe job.
 * Triggered at exact T-0 by BullMQ worker or precision scheduler.
 */
export async function processSnipeJob(
  payload: SnipeJobPayload,
): Promise<SnipeExecutionReport> {
  const {
    taskId,
    userId,
    chatId,
    messageId,
    contractAddress,
    quantity,
    rpcUrls,
    armedSnipe,
    targetTimeMs,
  } = payload;

  console.log(
    `🚀 [Worker] Starting T-0 execution for Task ${taskId} (User ${userId})`,
  );

  // Pre-warm connections before T-0
  warmRpcConnections(rpcUrls).catch(() => {});

  // Micro-spin wait for exact sub-millisecond precision
  while (Date.now() < targetTimeMs) {
    await new Promise((r) => setImmediate(r));
  }

  const fireStartTime = Date.now();
  const t0DeltaMs = fireStartTime - targetTimeMs;

  // 1. Update task status in Supabase
  await updateMintTask(taskId, { status: "executing" });
  await logActivity(
    userId,
    `Fired transaction for ${contractAddress.slice(0, 10)}... (T+${Math.max(0, t0DeltaMs)}ms)`,
    "info",
    taskId,
  );

  // 2. Execute pre-signed armed snipe with live Telegram streaming
  const report = await executeArmedSnipe(
    armedSnipe,
    rpcUrls,
    (log) => logActivity(userId, log.message, log.type, taskId),
    async (progress) => {
      if (progress.phase === "dispatched") {
        const txLinks = (progress.txHashes || [])
          .map(
            (h, i) =>
              `🔗 <b>TX:</b> ${link(h.slice(0, 16) + "...", progress.explorerUrls?.[i] || "#")}`,
          )
          .join("\n");

        const timingInfo =
          progress.dispatchLatencyMs !== undefined
            ? `⚡ <b>Dispatched in ${progress.dispatchLatencyMs}ms</b> <i>(T+${Math.max(0, t0DeltaMs)}ms)</i>\n`
            : "";

        await updateCard(
          chatId,
          messageId,
          `🚀 <b>Firing Transaction — Attempt ${progress.attempt}/${progress.maxAttempts}</b>\n\n` +
            `🎯 <b>Collection:</b> ${code(contractAddress)}\n` +
            `📡 <b>Dispatched to mempool across ${rpcUrls.length} RPCs!</b>\n` +
            timingInfo +
            `${txLinks}\n\n` +
            `⏳ <i>Monitoring on-chain block inclusion (200ms polling)...</i>\n` +
            `🟢 <i>Live event stream active — no action needed.</i>`,
          getLiveExecutionKeyboard(),
        );
      } else if (progress.phase === "retrying") {
        await updateCard(
          chatId,
          messageId,
          `⚠️ <b>Attempt ${progress.attempt - 1} did not confirm</b>\n\n` +
            `🎯 <b>Collection:</b> ${code(contractAddress)}\n` +
            `🔄 <i>Instantly firing pre-signed Attempt ${progress.attempt} with +25% priority fee bump...</i>\n` +
            `🟢 <i>Live event stream active — no action needed.</i>`,
          getLiveExecutionKeyboard(),
        );
      }
    },
  );

  // 3. Update Supabase with final execution results
  const txHashes = report.results.map((r) => r.txHash);

  if (report.confirmed && report.confirmedResult) {
    const r = report.confirmedResult;

    await updateMintTask(taskId, {
      status: "completed",
      tx_hashes: txHashes,
      attempts_run: report.attemptsRun,
      successful_attempt: report.successfulAttempt,
      block_number: r.blockNumber,
      gas_used: r.gasUsed,
    });

    await logActivity(
      userId,
      `✅ Mint confirmed on Attempt ${report.successfulAttempt} in block ${r.blockNumber} (Gas: ${r.gasUsed})`,
      "success",
      taskId,
    );

    // Fetch user RPC state for keyboard
    const user = await getUser(userId);
    const hasRpc = Boolean(user?.custom_rpc_encrypted);

    await updateCard(
      chatId,
      messageId,
      `🎉 <b>NFT Mint Snipe Confirmed!</b>\n\n` +
        `🎯 <b>Collection:</b> ${code(contractAddress)}\n` +
        `👤 <b>Minter:</b> ${code(r.address)}\n` +
        `🔢 <b>Quantity:</b> <code>${quantity}</code>\n` +
        `⚡ <b>Succeeded On:</b> <b>Attempt ${report.successfulAttempt} of 3</b> <i>(Stopped remaining attempts)</i>\n` +
        `📦 <b>Block:</b> <code>${r.blockNumber}</code>\n` +
        `⛽ <b>Gas Used:</b> <code>${r.gasUsed}</code>\n` +
        `⏱️ <b>Total Execution Time:</b> <code>${report.totalExecutionMs || 0}ms</code>\n` +
        `🔗 <b>Transaction:</b> ${link(r.txHash.slice(0, 18) + "...", r.explorerUrl)}\n\n` +
        `✅ <i>Mint transaction verified on-chain automatically!</i>\n\n` +
        `⚡ Built by <a href="https://x.com/valor0x">Valor</a>`,
      getMainMenuKeyboard(hasRpc),
    );
  } else {
    await updateMintTask(taskId, {
      status: "failed",
      tx_hashes: txHashes,
      attempts_run: report.attemptsRun,
      error:
        report.error ||
        "All sequential attempts exhausted without confirmation",
    });

    await logActivity(
      userId,
      `❌ Snipe failed for ${contractAddress.slice(0, 10)}... (${report.error || "No confirmation"})`,
      "error",
      taskId,
    );

    const attemptLines = report.results
      .map(
        (r) =>
          `  • Attempt ${r.attempt}: <b>${r.status.toUpperCase()}</b> (${esc(r.error || "No receipt")}) — ${link("TX", r.explorerUrl)}`,
      )
      .join("\n");

    const user = await getUser(userId);
    const hasRpc = Boolean(user?.custom_rpc_encrypted);

    await updateCard(
      chatId,
      messageId,
      `❌ <b>Snipe Finished Without Confirmation</b>\n\n` +
        `🎯 <b>Collection:</b> ${code(contractAddress)}\n\n` +
        `<b>Attempt History:</b>\n${attemptLines}\n\n` +
        `<i>All sequential attempts were exhausted.</i>`,
      getMainMenuKeyboard(hasRpc),
    );
  }

  return report;
}

// Register processor for in-memory and BullMQ queue execution
registerJobProcessor(processSnipeJob);

/**
 * Starts the persistent BullMQ Worker.
 */
export function startWorker(): Worker<SnipeJobPayload> | null {
  if (snipeWorker) return snipeWorker;

  const conn = getRedisConnection();
  if (!conn) {
    console.log(
      "ℹ️ REDIS_URL not configured — BullMQ persistent worker standby (in-memory scheduler active)",
    );
    return null;
  }

  try {
    snipeWorker = new Worker<SnipeJobPayload>(
      SNIPE_QUEUE_NAME,
      async (job: Job<SnipeJobPayload>) => {
        return await processSnipeJob(job.data);
      },
      {
        connection: conn,
        concurrency: 10,
        limiter: {
          max: 100,
          duration: 1000,
        },
      },
    );

    snipeWorker.on("ready", () => {
      console.log(
        "⚡ [BullMQ Worker] Worker is READY and listening for T-0 jobs",
      );
    });

    snipeWorker.on("completed", (job) => {
      console.log(`✅ [BullMQ Worker] Job ${job.id} completed successfully`);
    });

    snipeWorker.on("failed", (job, err) => {
      console.error(`❌ [BullMQ Worker] Job ${job?.id} failed:`, err.message);
    });

    return snipeWorker;
  } catch (err: any) {
    console.warn("⚠️ BullMQ Worker startup notice:", err.message);
    return null;
  }
}
