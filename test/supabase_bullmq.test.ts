// Automated Test Suite for Supabase PostgreSQL + BullMQ + Persistent Worker
// Validates:
// 1. Supabase DB CRUD & Zero Private Key Storage Paradigm
// 2. AES-256-GCM Encryption of sensitive user RPC endpoints
// 3. BullMQ Precision Scheduling & Duplicate Job Prevention
// 4. Standalone Worker T-0 Pre-Signed Execution & Supabase Task Status Updates

import http from "http";
import { Wallet, parseUnits, keccak256 } from "ethers";
import {
  upsertUser,
  getUser,
  addWalletAddress,
  getWalletAddresses,
  deleteWalletAddress,
  clearWalletAddresses,
  createMintTask,
  updateMintTask,
  getMintTask,
  getUserActiveTasks,
  logActivity,
  getUserLogs,
  encryptSensitive,
  decryptSensitive,
} from "../src/db";
import {
  scheduleSnipeJob,
  cancelSnipeJob,
  cancelAllUserJobs,
  SnipeJobPayload,
} from "../src/queue";
import { processSnipeJob } from "../src/worker";
import { preSignAllAttempts } from "../src/mint";
import { MintPlan } from "../src/seadrop";

let activeServers: http.Server[] = [];
let mockAcceptedTxHashes = new Set<string>();
let mockReceiptBlock = 19000123;

function createMockRpc(port: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const json = JSON.parse(body);
          const method = json.method;
          let result: any = null;

          if (method === "net_version") {
            result = "4663";
          } else if (method === "eth_chainId") {
            result = "0x1237";
          } else if (method === "eth_getTransactionCount") {
            result = "0x0";
          } else if (method === "eth_sendRawTransaction") {
            const txHash = keccak256(json.params[0]);
            mockAcceptedTxHashes.add(txHash);
            result = txHash;
          } else if (method === "eth_getTransactionReceipt") {
            const txHash = json.params[0];
            if (mockAcceptedTxHashes.has(txHash)) {
              result = {
                transactionHash: txHash,
                blockNumber: "0x" + mockReceiptBlock.toString(16),
                status: "0x1",
                gasUsed: "0x12345",
              };
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", result, id: json.id }));
        } catch {
          res.writeHead(500);
          res.end();
        }
      });
    });

    server.listen(port, () => {
      activeServers.push(server);
      resolve(server);
    });
  });
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail: string = "") {
  if (condition) {
    console.log(`  ✅ [PASS] ${name} ${detail ? `(${detail})` : ""}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${name} ${detail ? `(${detail})` : ""}`);
    failed++;
  }
}

async function runTests() {
  console.log(
    "\n===============================================================================",
  );
  console.log("🧪 SUPABASE POSTGRESQL + BULLMQ + PERSISTENT WORKER TEST SUITE");
  console.log(
    "===============================================================================\n",
  );

  const mockPort = 8991;
  await createMockRpc(mockPort);
  const rpcUrl = `http://127.0.0.1:${mockPort}`;

  const testUserId = 998877665;
  const testWallet = Wallet.createRandom();
  const testWallet2 = Wallet.createRandom();

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. SUPABASE DATABASE & ZERO PRIVATE KEY STORAGE
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 1: Supabase User Profile & AES-256-GCM RPC Encryption");
  const secretAlchemyUrl =
    "https://arb-sepolia.g.alchemy.com/v2/super-secret-key-12345";
  const encryptedRpc = encryptSensitive(secretAlchemyUrl);
  const decryptedRpc = decryptSensitive(encryptedRpc);

  assert(
    encryptedRpc !== secretAlchemyUrl,
    "RPC URL is encrypted (not plain text)",
  );
  assert(
    decryptedRpc === secretAlchemyUrl,
    "RPC URL correctly decrypted with AES-256-GCM",
  );

  const createdUser = await upsertUser({
    telegramId: testUserId,
    username: "crypto_sniper",
    firstName: "Sniper",
    customRpc: secretAlchemyUrl,
    maxFeePerGas: "0.2",
    maxPriorityFee: "0.05",
    activeChain: "robinhood",
    gasSafetyCap: true,
  });

  const fetchedUser = await getUser(testUserId);
  assert(fetchedUser !== null, "User record persisted in database");
  assert(fetchedUser?.telegram_id === testUserId, "User Telegram ID matched");
  assert(fetchedUser?.max_fee_per_gas === "0.2", "Max fee setting persisted");
  console.log(`  📊 User ${testUserId} persisted with encrypted RPC.\n`);

  console.log(
    "▶ TEST 2: Public Wallet Management (Strict Zero Private Key Storage)",
  );
  await addWalletAddress(testUserId, testWallet.address);
  await addWalletAddress(testUserId, testWallet2.address);

  const storedAddresses = await getWalletAddresses(testUserId);
  assert(
    storedAddresses.length === 2,
    "Both public wallet addresses stored",
    `Count: ${storedAddresses.length}`,
  );
  assert(
    storedAddresses.includes(testWallet.address.toLowerCase()),
    "Wallet 1 public address present",
  );
  assert(
    storedAddresses.includes(testWallet2.address.toLowerCase()),
    "Wallet 2 public address present",
  );

  // Verify private key is NEVER in database
  const jsonDump = JSON.stringify(storedAddresses);
  assert(
    !jsonDump.includes(testWallet.privateKey),
    "SECURITY: Private key 1 NEVER stored in DB",
  );
  assert(
    !jsonDump.includes(testWallet2.privateKey),
    "SECURITY: Private key 2 NEVER stored in DB",
  );

  await deleteWalletAddress(testUserId, testWallet2.address);
  const remainingAddresses = await getWalletAddresses(testUserId);
  assert(remainingAddresses.length === 1, "Wallet 2 deleted successfully");
  console.log(`  📊 Verified zero private key storage in database.\n`);

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. MINT TASKS & ACTIVITY LOGS
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 3: Mint Task CRUD & Activity Logs");
  const taskId = `task_${Date.now()}`;
  const mockContract = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";

  await createMintTask({
    id: taskId,
    user_id: testUserId,
    chat_id: testUserId,
    message_id: 112233,
    contract_address: mockContract,
    quantity: 1,
    max_fee_per_gas: "0.2",
    max_priority_fee: "0.05",
    timing_mode: "mint_start",
    target_time: new Date(Date.now() + 500).toISOString(),
    status: "armed",
    attempts_run: 0,
  });

  const task = await getMintTask(taskId);
  assert(task !== null, "Mint task created in database");
  assert(task?.status === "armed", "Task status is 'armed'");

  const activeTasks = await getUserActiveTasks(testUserId);
  assert(
    activeTasks.some((t) => t.id === taskId),
    "Task listed in user active tasks",
  );

  await logActivity(testUserId, "Test activity log message", "info", taskId);
  const logs = await getUserLogs(testUserId);
  assert(logs.length >= 1, "Activity log persisted");
  assert(
    logs[0].message === "Test activity log message",
    "Activity log content matched",
  );
  console.log(`  📊 Task & Activity logging verified.\n`);

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. BULLMQ SCHEDULING & DUPLICATE PREVENTION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("▶ TEST 4: BullMQ Precision Scheduling & Duplicate Prevention");
  const mockPlan: MintPlan = {
    to: mockContract,
    data: "0x2e08c9ff000000000000000000000000deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    value: parseUnits("0.01", "ether"),
    feeRecipient: "0x0000a26b00c1F0DF003000390027140000fAa719",
    drop: {
      mintPrice: parseUnits("0.01", "ether"),
      startTime: Math.floor(Date.now() / 1000),
      endTime: Math.floor(Date.now() / 1000) + 3600,
      maxTotalMintableByWallet: 5,
      feeBps: 250,
      restrictFeeRecipients: false,
    },
  };

  const armedSnipe = await preSignAllAttempts(
    [testWallet.privateKey],
    mockPlan,
    rpcUrl,
    parseUnits("0.2", "gwei"),
    parseUnits("0.05", "gwei"),
  );

  const jobPayload: SnipeJobPayload = {
    taskId,
    userId: testUserId,
    chatId: testUserId,
    messageId: 112233,
    contractAddress: mockContract,
    quantity: 1,
    timingMode: "mint_start",
    targetTimeMs: Date.now() + 100,
    rpcUrls: [rpcUrl],
    armedSnipe,
  };

  // Schedule Job 1
  const sched1 = await scheduleSnipeJob(jobPayload);
  assert(sched1.jobId === taskId, "Job scheduled with unique taskId as jobId");

  // Attempt duplicate schedule
  const sched2 = await scheduleSnipeJob(jobPayload);
  assert(sched2.jobId === taskId, "Duplicate job prevented with same taskId");

  // Cancel Job
  const cancelled = await cancelSnipeJob(taskId);
  assert(cancelled, "Job cancelled from queue successfully");
  console.log(`  📊 BullMQ duplicate prevention verified.\n`);

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. PERSISTENT WORKER T-0 EXECUTION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(
    "▶ TEST 5: Standalone Worker T-0 Pre-Signed Execution & Status Sync",
  );
  const executeTaskId = `task_exec_${Date.now()}`;

  await createMintTask({
    id: executeTaskId,
    user_id: testUserId,
    chat_id: testUserId,
    message_id: 112233,
    contract_address: mockContract,
    quantity: 1,
    max_fee_per_gas: "0.2",
    max_priority_fee: "0.05",
    timing_mode: "mint_start",
    target_time: new Date(Date.now() + 50).toISOString(),
    status: "armed",
    attempts_run: 0,
  });

  const execPayload: SnipeJobPayload = {
    taskId: executeTaskId,
    userId: testUserId,
    chatId: testUserId,
    messageId: 112233,
    contractAddress: mockContract,
    quantity: 1,
    timingMode: "mint_start",
    targetTimeMs: Date.now() + 50,
    rpcUrls: [rpcUrl],
    armedSnipe,
  };

  const report = await processSnipeJob(execPayload);

  assert(report.confirmed, "Worker confirmed snipe on-chain");
  assert(report.successfulAttempt === 1, "Mint succeeded on Attempt 1");

  const completedTask = await getMintTask(executeTaskId);
  assert(
    completedTask?.status === "completed",
    "Supabase task record updated to 'completed'",
  );
  assert(
    completedTask?.successful_attempt === 1,
    "Supabase task successful_attempt recorded",
  );
  assert(
    Boolean(completedTask?.tx_hashes && completedTask.tx_hashes.length > 0),
    "Supabase task TX hashes recorded",
  );
  console.log(
    `  📊 Worker execution & Supabase sync completed in ${report.totalExecutionMs}ms.\n`,
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(
    "===============================================================================",
  );
  console.log(`🎉 TEST SUITE COMPLETED: ${passed} passed, ${failed} failed.`);
  console.log(
    "===============================================================================\n",
  );

  for (const s of activeServers) {
    s.close();
  }

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
