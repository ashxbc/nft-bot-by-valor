// High-precision autonomous sniper scheduler and connection warmer.
// Pre-warms keep-alive RPC connections and triggers sub-millisecond dispatch at exact T-0.
// On serverless (Vercel), holds execution open for upcoming drops so the Lambda does NOT freeze before T-0.

import {
  ArmedSnipe,
  executeArmedSnipe,
  warmRpcConnections,
  SnipeExecutionReport,
} from "./mint";
import { UserSession, ActiveSnipe } from "./session";
import {
  esc,
  code,
  link,
  getLiveExecutionKeyboard,
  getMainMenuKeyboard,
} from "./menu";

export interface ScheduledSnipeTask {
  id: string;
  armedSnipe: ArmedSnipe;
  chatId: number;
  messageId: number;
  targetTimeMs: number;
  timingMode: "mint_start" | "specific_time" | "now";
  rpcUrls: string[];
  sess: UserSession;
  activeSnipe: ActiveSnipe;
  api: any;
  onExecuted?: (
    report: SnipeExecutionReport | null,
    executedAtMs: number,
  ) => void;
}

class PrecisionScheduler {
  private tasks = new Map<string, ScheduledSnipeTask>();
  private activeTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Helper to update Telegram card in real-time without throwing on duplicate edits.
   */
  async updateCard(
    api: any,
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: any,
  ) {
    try {
      await api.editMessageText(chatId, messageId, text, {
        parse_mode: "HTML",
        reply_markup: replyMarkup,
        link_preview_options: { is_disabled: true },
      });
    } catch (err: any) {
      if (!err.message?.includes("message is not modified")) {
        // Silently ignore duplicate stream updates
      }
    }
  }

  /**
   * Arms and registers a pre-signed snipe for autonomous T-0 execution.
   * If targetTime is within 4 minutes, holds the promise open so serverless environments (Vercel) do not sleep.
   */
  async scheduleSnipe(
    task: ScheduledSnipeTask,
  ): Promise<SnipeExecutionReport | null> {
    const { id, targetTimeMs, rpcUrls } = task;
    this.cancelTask(id);
    this.tasks.set(id, task);

    const now = Date.now();
    const waitMs = targetTimeMs - now;

    // Pre-warm connections immediately upon arming
    warmRpcConnections(rpcUrls).catch(() => {});

    if (waitMs <= 0) {
      // Immediate execution
      return await this.fireTask(id);
    }

    // Schedule connection pre-warming steps before T-0 (at T-10s, T-5s, T-2s, T-1s, T-500ms)
    const warmingTimes = [10000, 5000, 2000, 1000, 500];
    for (const warmOffset of warmingTimes) {
      if (waitMs > warmOffset) {
        const timer = setTimeout(() => {
          warmRpcConnections(rpcUrls).catch(() => {});
        }, waitMs - warmOffset);
        if (timer.unref) timer.unref();
      }
    }

    // If drop is within 240 seconds (4 minutes), hold the execution context open to guarantee execution
    if (waitMs <= 240_000) {
      return new Promise<SnipeExecutionReport | null>((resolve) => {
        const leadTimeMs = Math.min(50, Math.max(0, waitMs));
        const timerDelay = Math.max(0, waitMs - leadTimeMs);

        const triggerTimer = setTimeout(async () => {
          while (Date.now() < targetTimeMs) {
            await new Promise((r) => setImmediate(r));
          }
          const rep = await this.fireTask(id);
          resolve(rep);
        }, timerDelay);

        this.activeTimers.set(id, triggerTimer);
      });
    } else {
      // Long-term wait (> 4 min): register background timer
      const leadTimeMs = Math.min(50, Math.max(0, waitMs));
      const timerDelay = Math.max(0, waitMs - leadTimeMs);

      const triggerTimer = setTimeout(async () => {
        while (Date.now() < targetTimeMs) {
          await new Promise((r) => setImmediate(r));
        }
        await this.fireTask(id);
      }, timerDelay);

      if (triggerTimer.unref) triggerTimer.unref();
      this.activeTimers.set(id, triggerTimer);
      return null;
    }
  }

  /**
   * Fires the pre-signed armed snipe at T-0 with 0ms preparation delay.
   */
  async fireTask(id: string): Promise<SnipeExecutionReport | null> {
    const task = this.tasks.get(id);
    if (!task) return null;

    this.cancelTask(id);
    const {
      armedSnipe,
      rpcUrls,
      chatId,
      messageId,
      api,
      sess,
      activeSnipe,
      targetTimeMs,
    } = task;

    activeSnipe.status = "firing";
    const fireStartTime = Date.now();
    const t0DeltaMs = fireStartTime - targetTimeMs;

    try {
      const report = await executeArmedSnipe(
        armedSnipe,
        rpcUrls,
        (log) => sess.logs.push(log),
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

            await this.updateCard(
              api,
              chatId,
              messageId,
              `🚀 <b>Firing Transaction — Attempt ${progress.attempt}/${progress.maxAttempts}</b>\n\n` +
                `🎯 <b>Collection:</b> ${code(armedSnipe.contractAddress || "SeaDrop")}\n` +
                `📡 <b>Dispatched to mempool across ${rpcUrls.length} RPCs!</b>\n` +
                timingInfo +
                `${txLinks}\n\n` +
                `⏳ <i>Monitoring on-chain block inclusion (200ms polling)...</i>\n` +
                `🟢 <i>Live event stream active — no action needed.</i>`,
              getLiveExecutionKeyboard(),
            );
          } else if (progress.phase === "retrying") {
            await this.updateCard(
              api,
              chatId,
              messageId,
              `⚠️ <b>Attempt ${progress.attempt - 1} did not confirm</b>\n\n` +
                `🎯 <b>Collection:</b> ${code(armedSnipe.contractAddress || "SeaDrop")}\n` +
                `🔄 <i>Instantly firing pre-signed Attempt ${progress.attempt} with +25% priority fee bump...</i>\n` +
                `🟢 <i>Live event stream active — no action needed.</i>`,
              getLiveExecutionKeyboard(),
            );
          }
        },
      );

      activeSnipe.txHashes = report.results.map((r) => r.txHash);
      activeSnipe.status = report.confirmed ? "completed" : "failed";

      if (report.confirmed && report.confirmedResult) {
        const r = report.confirmedResult;
        await this.updateCard(
          api,
          chatId,
          messageId,
          `🎉 <b>NFT Mint Snipe Confirmed!</b>\n\n` +
            `🎯 <b>Collection:</b> ${code(armedSnipe.contractAddress || "SeaDrop")}\n` +
            `👤 <b>Minter:</b> ${code(r.address)}\n` +
            `🔢 <b>Quantity:</b> <code>${task.armedSnipe.quantity}</code>\n` +
            `⚡ <b>Succeeded On:</b> <b>Attempt ${report.successfulAttempt} of 3</b> <i>(Stopped remaining attempts)</i>\n` +
            `📦 <b>Block:</b> <code>${r.blockNumber}</code>\n` +
            `⛽ <b>Gas Used:</b> <code>${r.gasUsed}</code>\n` +
            `⏱️ <b>Total Execution Time:</b> <code>${report.totalExecutionMs || 0}ms</code>\n` +
            `🔗 <b>Transaction:</b> ${link(r.txHash.slice(0, 18) + "...", r.explorerUrl)}\n\n` +
            `✅ <i>Mint transaction verified on-chain automatically!</i>\n\n` +
            `⚡ Built by <a href="https://x.com/valor0x">Valor</a>`,
          getMainMenuKeyboard(Boolean(sess.settings.customRpc)),
        );
        const attemptLines =
          report.results && report.results.length > 0
            ? report.results
                .map(
                  (r) =>
                    `  • Attempt ${r.attempt}: <b>${r.status.toUpperCase()}</b>\n    └ <i>${esc(r.error || "Mempool inclusion timeout — no receipt")}</i>${r.txHash ? ` — ${link("View TX", r.explorerUrl)}` : ""}`,
                )
                .join("\n")
            : "  • ⚠️ No transactions could be broadcast. (Check wallet balance and RPC endpoint)";

        await this.updateCard(
          api,
          chatId,
          messageId,
          `❌ <b>Snipe Finished Without Confirmation</b>\n\n` +
            `🎯 <b>Collection:</b> ${code(armedSnipe.contractAddress || "SeaDrop")}\n\n` +
            `<b>Attempt History:</b>\n${attemptLines}\n\n` +
            `<i>All sequential attempts were exhausted.</i>\n\n` +
            `⚡ Built by <a href="https://x.com/valor0x">Valor</a>`,
          getMainMenuKeyboard(Boolean(sess.settings.customRpc)),
        );
      }

      if (task.onExecuted) {
        task.onExecuted(report, fireStartTime);
      }
      return report;
    } catch (err: any) {
      activeSnipe.status = "failed";
      await this.updateCard(
        api,
        chatId,
        messageId,
        `❌ <b>Snipe execution error:</b> ${esc(err.message)}`,
        getMainMenuKeyboard(Boolean(sess.settings.customRpc)),
      );
      if (task.onExecuted) {
        task.onExecuted(null, fireStartTime);
      }
      return null;
    }
  }

  cancelTask(id: string): boolean {
    const timer = this.activeTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(id);
    }
    const had = this.tasks.has(id);
    this.tasks.delete(id);
    return had;
  }

  cancelAll(): number {
    let count = 0;
    for (const id of this.tasks.keys()) {
      this.cancelTask(id);
      count++;
    }
    return count;
  }

  getTask(id: string): ScheduledSnipeTask | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): ScheduledSnipeTask[] {
    return Array.from(this.tasks.values());
  }
}

export const precisionScheduler = new PrecisionScheduler();
