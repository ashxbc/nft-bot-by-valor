// Supabase PostgreSQL Database Layer
// Zero Private Key Storage Paradigm:
// - Users table stores profiles & AES-256-GCM encrypted custom RPC endpoints.
// - Wallets table stores ONLY public addresses (0x...). Private keys are NEVER stored in DB.
// - Mint tasks & activity logs are persisted permanently per user.

import "dotenv/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { getAddress } from "ethers";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";

const ALGORITHM = "aes-256-gcm";
const SALT = "seadrop-sniper-db-v1";

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SALT, 32);
}

function getMasterKey(): string {
  const key = process.env.SESSION_ENCRYPTION_KEY;
  if (key && key.length >= 32) return key;
  const botToken = process.env.BOT_TOKEN || "default-dev-db-master-key-32ch";
  return botToken.padEnd(32, "0").slice(0, 32);
}

/**
 * Encrypts sensitive strings (e.g. personal Alchemy RPC URLs) before storing in PostgreSQL.
 */
export function encryptSensitive(plainText: string): string {
  if (!plainText) return "";
  const key = deriveKey(getMasterKey());
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plainText, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts sensitive strings stored in PostgreSQL.
 */
export function decryptSensitive(encryptedText: string): string {
  if (!encryptedText) return "";
  try {
    const parts = encryptedText.split(":");
    if (parts.length !== 3) return encryptedText; // Legacy unencrypted fallback

    const [ivHex, authTagHex, dataHex] = parts;
    const key = deriveKey(getMasterKey());
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(dataHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err: any) {
    console.warn("⚠️ decryptSensitive notice:", err.message);
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA MODELS
// ─────────────────────────────────────────────────────────────────────────────
export interface DbUser {
  telegram_id: number;
  username?: string;
  first_name?: string;
  custom_rpc_encrypted?: string;
  max_fee_per_gas: string;
  max_priority_fee: string;
  gas_safety_cap: boolean;
  active_chain: string;
  created_at?: string;
  updated_at?: string;
}

export interface DbWallet {
  id?: string;
  user_id: number;
  address: string;
  created_at?: string;
}

export interface DbMintTask {
  id: string;
  user_id: number;
  chat_id: number;
  message_id?: number;
  contract_address: string;
  quantity: number;
  max_fee_per_gas: string;
  max_priority_fee: string;
  timing_mode: string;
  target_time?: string;
  status:
    | "pending"
    | "armed"
    | "executing"
    | "completed"
    | "failed"
    | "cancelled";
  tx_hashes?: string[];
  attempts_run?: number;
  successful_attempt?: number;
  block_number?: number;
  gas_used?: string;
  error?: string;
  created_at?: string;
  updated_at?: string;
}

export interface DbActivityLog {
  id?: string;
  user_id: number;
  task_id?: string;
  message: string;
  type: "info" | "success" | "error" | "warning";
  created_at?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE CLIENT INITIALIZATION & IN-MEMORY FALLBACK DRIVER
// ─────────────────────────────────────────────────────────────────────────────
let supabaseClient: SupabaseClient | null = null;
let hasLoggedSupabaseStatus = false;

export function getSupabase(): SupabaseClient | null {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL || "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_KEY ||
    "";

  if (url && key) {
    try {
      supabaseClient = createClient(url, key, {
        auth: { persistSession: false },
      });
      if (!hasLoggedSupabaseStatus) {
        console.log("✅ Connected to Supabase PostgreSQL Database:", url);
        hasLoggedSupabaseStatus = true;
      }
      return supabaseClient;
    } catch (err: any) {
      console.error("❌ Supabase connection error:", err.message);
      return null;
    }
  }

  if (!hasLoggedSupabaseStatus) {
    console.log(
      "ℹ️ SUPABASE_URL / SUPABASE_KEY not detected in environment — operating with in-memory persistence.",
    );
    hasLoggedSupabaseStatus = true;
  }
  return null;
}

// In-Memory fallback store for tests / local dev without Supabase credentials
const memoryUsers = new Map<number, DbUser>();
const memoryWallets = new Map<number, Set<string>>(); // userId -> Set<address>
const memoryTasks = new Map<string, DbMintTask>();
const memoryLogs = new Map<number, DbActivityLog[]>();

// ─────────────────────────────────────────────────────────────────────────────
// USER CRUD
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertUser(user: {
  telegramId: number;
  username?: string;
  firstName?: string;
  customRpc?: string;
  maxFeePerGas?: string;
  maxPriorityFee?: string;
  gasSafetyCap?: boolean;
  activeChain?: string;
}): Promise<DbUser> {
  const existing = await getUser(user.telegramId);

  const customRpcEncrypted =
    user.customRpc !== undefined
      ? encryptSensitive(user.customRpc)
      : existing?.custom_rpc_encrypted || "";

  const record: DbUser = {
    telegram_id: user.telegramId,
    username: user.username !== undefined ? user.username : existing?.username,
    first_name:
      user.firstName !== undefined ? user.firstName : existing?.first_name,
    custom_rpc_encrypted: customRpcEncrypted,
    max_fee_per_gas: user.maxFeePerGas || existing?.max_fee_per_gas || "0.1",
    max_priority_fee:
      user.maxPriorityFee || existing?.max_priority_fee || "0.01",
    gas_safety_cap:
      user.gasSafetyCap !== undefined
        ? user.gasSafetyCap
        : (existing?.gas_safety_cap ?? true),
    active_chain: user.activeChain || existing?.active_chain || "robinhood",
    updated_at: new Date().toISOString(),
  };

  const client = getSupabase();
  if (client) {
    const { data, error } = await client
      .from("users")
      .upsert(record, { onConflict: "telegram_id" })
      .select()
      .single();

    if (error) {
      console.error(
        "❌ Supabase upsertUser error:",
        error.message,
        "(Hint: ensure supabase_schema.sql was run in Supabase SQL editor)",
      );
    } else if (data) {
      return data as DbUser;
    }
  }

  memoryUsers.set(user.telegramId, record);
  return record;
}

export async function getUser(telegramId: number): Promise<DbUser | null> {
  const client = getSupabase();
  if (client) {
    const { data, error } = await client
      .from("users")
      .select("*")
      .eq("telegram_id", telegramId)
      .single();

    if (!error && data) {
      return data as DbUser;
    }
  }

  return memoryUsers.get(telegramId) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// WALLET MANAGEMENT (PUBLIC ADDRESSES ONLY - ZERO PRIVATE KEYS STORED)
// ─────────────────────────────────────────────────────────────────────────────
export async function addWalletAddress(
  telegramId: number,
  address: string,
): Promise<boolean> {
  let normalized = address.trim();
  try {
    normalized = getAddress(normalized);
  } catch {}

  // Ensure user exists first
  await upsertUser({ telegramId });

  const client = getSupabase();
  if (client) {
    // Delete any case-variations first (e.g. lowercase version) to prevent duplicate entries
    await client
      .from("wallets")
      .delete()
      .eq("user_id", telegramId)
      .ilike("address", normalized);

    const { error } = await client
      .from("wallets")
      .upsert(
        { user_id: telegramId, address: normalized },
        { onConflict: "user_id,address" },
      );

    if (error) {
      console.error("❌ Supabase addWalletAddress error:", error.message);
    } else {
      console.log(
        `✅ Saved public wallet ${normalized.slice(0, 10)}... for user ${telegramId} in Supabase`,
      );
    }
  }

  let set = memoryWallets.get(telegramId);
  if (!set) {
    set = new Set();
    memoryWallets.set(telegramId, set);
  }
  for (const existing of Array.from(set)) {
    if (existing.toLowerCase() === normalized.toLowerCase()) {
      set.delete(existing);
    }
  }
  set.add(normalized);
  return true;
}

export async function getWalletAddresses(
  telegramId: number,
): Promise<string[]> {
  const client = getSupabase();
  if (client) {
    const { data, error } = await client
      .from("wallets")
      .select("address")
      .eq("user_id", telegramId)
      .order("created_at", { ascending: true });

    if (!error && data) {
      const addressMap = new Map<string, string>();
      for (const d of data) {
        let norm = d.address;
        try {
          norm = getAddress(d.address);
        } catch {}
        if (!addressMap.has(norm.toLowerCase())) {
          addressMap.set(norm.toLowerCase(), norm);
        }
      }
      return Array.from(addressMap.values());
    }
  }

  const set = memoryWallets.get(telegramId);
  if (!set) return [];
  const addressMap = new Map<string, string>();
  for (const a of Array.from(set)) {
    let norm = a;
    try {
      norm = getAddress(a);
    } catch {}
    if (!addressMap.has(norm.toLowerCase())) {
      addressMap.set(norm.toLowerCase(), norm);
    }
  }
  return Array.from(addressMap.values());
}

export async function deleteWalletAddress(
  telegramId: number,
  address: string,
): Promise<boolean> {
  let normalized = address.trim();
  try {
    normalized = getAddress(normalized);
  } catch {}

  const client = getSupabase();
  if (client) {
    await client
      .from("wallets")
      .delete()
      .eq("user_id", telegramId)
      .ilike("address", normalized);
  }

  const set = memoryWallets.get(telegramId);
  if (set) {
    for (const existing of Array.from(set)) {
      if (existing.toLowerCase() === normalized.toLowerCase()) {
        set.delete(existing);
      }
    }
  }
  return true;
}

export async function clearWalletAddresses(telegramId: number): Promise<void> {
  const client = getSupabase();
  if (client) {
    await client.from("wallets").delete().eq("user_id", telegramId);
  }
  memoryWallets.delete(telegramId);
}

// ─────────────────────────────────────────────────────────────────────────────
// MINT TASK MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
export async function createMintTask(task: DbMintTask): Promise<void> {
  const client = getSupabase();
  if (client) {
    const { error } = await client
      .from("mint_tasks")
      .upsert(task, { onConflict: "id" });
    if (error) {
      console.error("❌ Supabase createMintTask error:", error.message);
    } else {
      console.log(
        `✅ Saved mint task ${task.id} in Supabase (Status: ${task.status})`,
      );
    }
  }
  memoryTasks.set(task.id, { ...task });
}

export async function updateMintTask(
  taskId: string,
  updates: Partial<DbMintTask>,
): Promise<void> {
  const payload = {
    ...updates,
    updated_at: new Date().toISOString(),
  };

  const client = getSupabase();
  if (client) {
    const { error } = await client
      .from("mint_tasks")
      .update(payload)
      .eq("id", taskId);
    if (error) {
      console.error("❌ Supabase updateMintTask error:", error.message);
    }
  }

  const existing = memoryTasks.get(taskId);
  if (existing) {
    memoryTasks.set(taskId, { ...existing, ...payload });
  }
}

export async function getMintTask(taskId: string): Promise<DbMintTask | null> {
  const client = getSupabase();
  if (client) {
    const { data, error } = await client
      .from("mint_tasks")
      .select("*")
      .eq("id", taskId)
      .single();

    if (!error && data) {
      return data as DbMintTask;
    }
  }

  return memoryTasks.get(taskId) || null;
}

export async function getUserActiveTasks(
  telegramId: number,
): Promise<DbMintTask[]> {
  const client = getSupabase();
  if (client) {
    const { data, error } = await client
      .from("mint_tasks")
      .select("*")
      .eq("user_id", telegramId)
      .in("status", ["pending", "armed", "executing"])
      .order("created_at", { ascending: false });

    if (!error && data) {
      return data as DbMintTask[];
    }
  }

  const list: DbMintTask[] = [];
  for (const t of memoryTasks.values()) {
    if (
      t.user_id === telegramId &&
      (t.status === "pending" ||
        t.status === "armed" ||
        t.status === "executing")
    ) {
      list.push(t);
    }
  }
  return list;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY LOGGING
// ─────────────────────────────────────────────────────────────────────────────
export async function logActivity(
  userId: number,
  message: string,
  type: "info" | "success" | "error" | "warning" = "info",
  taskId?: string,
): Promise<void> {
  const entry: DbActivityLog = {
    user_id: userId,
    task_id: taskId,
    message,
    type,
    created_at: new Date().toISOString(),
  };

  const client = getSupabase();
  if (client) {
    try {
      await client.from("activity_logs").insert(entry);
    } catch {}
  }

  let list = memoryLogs.get(userId);
  if (!list) {
    list = [];
    memoryLogs.set(userId, list);
  }
  list.unshift(entry);
  if (list.length > 50) list.pop(); // Keep recent 50 logs in memory
}

export async function getUserLogs(
  userId: number,
  limit: number = 20,
): Promise<DbActivityLog[]> {
  const client = getSupabase();
  if (client) {
    const { data, error } = await client
      .from("activity_logs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (!error && data) {
      return data as DbActivityLog[];
    }
  }

  const list = memoryLogs.get(userId) || [];
  return list.slice(0, limit);
}
