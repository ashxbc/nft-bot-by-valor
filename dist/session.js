"use strict";
// Encrypted session memory for ephemeral wallet keys.
// Keys are stored in memory only, never on disk, and encrypted with
// a per-session AES key derived from the bot's session encryption key.
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptWallet = encryptWallet;
exports.decryptWallet = decryptWallet;
exports.createDefaultSession = createDefaultSession;
const crypto_1 = require("crypto");
const ALGORITHM = "aes-256-gcm";
const SALT = "seadrop-sniper-bot-v1";
// Derive a 32-byte key from the session encryption key
function deriveKey(encryptionKey) {
    return (0, crypto_1.scryptSync)(encryptionKey, SALT, 32);
}
function getEncryptionKey() {
    const key = process.env.SESSION_ENCRYPTION_KEY;
    if (key && key.length >= 32)
        return key;
    // Fallback: use bot token as entropy source (still encrypted, just less ideal)
    const botToken = process.env.BOT_TOKEN || "default-dev-key-change-me";
    return botToken.padEnd(32, "0").slice(0, 32);
}
function encryptWallet(privateKey) {
    const key = deriveKey(getEncryptionKey());
    const iv = (0, crypto_1.randomBytes)(16);
    const cipher = (0, crypto_1.createCipheriv)(ALGORITHM, key, iv);
    let encrypted = cipher.update(privateKey, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag();
    return {
        iv: iv.toString("hex"),
        authTag: authTag.toString("hex"),
        data: encrypted,
    };
}
function decryptWallet(encrypted) {
    const key = deriveKey(getEncryptionKey());
    const iv = Buffer.from(encrypted.iv, "hex");
    const authTag = Buffer.from(encrypted.authTag, "hex");
    const decipher = (0, crypto_1.createDecipheriv)(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted.data, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
}
function createDefaultSession() {
    return {
        wallets: [],
        walletAddresses: [],
        settings: {
            customRpc: "",
            maxFeePerGas: "0.1",
            maxPriorityFee: "0.01",
            gasSafetyCap: true,
            activeChain: "arbitrum-sepolia",
        },
        activeSnipes: [],
        logs: [],
    };
}
//# sourceMappingURL=session.js.map