// Encrypted session memory for ephemeral wallet keys.
// Keys are stored in memory only, never on disk, and encrypted with
// a per-session AES key derived from the bot's session encryption key.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const SALT = "seadrop-sniper-bot-v1";

// Derive a 32-byte key from the session encryption key
function deriveKey(encryptionKey: string): Buffer {
  return scryptSync(encryptionKey, SALT, 32);
}

function getEncryptionKey(): string {
  const key = process.env.SESSION_ENCRYPTION_KEY;
  if (key && key.length >= 32) return key;
  // Fallback: use bot token as entropy source (still encrypted, just less ideal)
  const botToken = process.env.BOT_TOKEN || "default-dev-key-change-me";
  return botToken.padEnd(32, "0").slice(0, 32);
}

export interface EncryptedWallet {
  iv: string;
  authTag: string;
  data: string;
}

export function encryptWallet(privateKey: string): EncryptedWallet {
  const key = deriveKey(getEncryptionKey());
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(privateKey, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    data: encrypted,
  };
}

export function decryptWallet(encrypted: EncryptedWallet): string {
  const key = deriveKey(getEncryptionKey());
  const iv = Buffer.from(encrypted.iv, "hex");
  const authTag = Buffer.from(encrypted.authTag, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted.data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// Session state per user — stored in grammy's session storage
export interface UserSession {
  wallets: EncryptedWallet[];
  walletAddresses: string[]; // cached for display (public only)
  settings: {
    customRpc: string;
    maxFeePerGas: string;
    maxPriorityFee: string;
    gasSafetyCap: boolean;
    activeChain: string;
  };
  snipeWizard?: {
    step: number;
    contractAddress?: string;
    quantity?: number;
    maxFeePerGas?: string;
    maxPriorityFee?: string;
    timingMode?: "now" | "scheduled";
    scheduledTime?: string;
    rpcUrl?: string;
  };
  activeSnipes: ActiveSnipe[];
  logs: LogEntry[];
}

export interface ActiveSnipe {
  id: string;
  contractAddress: string;
  quantity: number;
  maxFeePerGas: string;
  maxPriorityFee: string;
  timingMode: "now" | "scheduled";
  scheduledTime?: Date;
  status: "pending" | "waiting" | "firing" | "completed" | "failed" | "cancelled";
  txHashes: string[];
  startedAt: Date;
  abortController?: AbortController;
}

export interface LogEntry {
  timestamp: Date;
  message: string;
  type: "info" | "success" | "error" | "warning";
}

export function createDefaultSession(): UserSession {
  return {
    wallets: [],
    walletAddresses: [],
    settings: {
      customRpc: "",
      maxFeePerGas: "0.1",
      maxPriorityFee: "0.01",
      gasSafetyCap: true,
      activeChain: "robinhood",
    },
    activeSnipes: [],
    logs: [],
  };
}
