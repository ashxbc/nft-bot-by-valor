// Persistent storage adapter for grammY sessions
// Works locally (./sessions.json) and on Vercel serverless (/tmp/sessions.json)
// Optional zero-config cloud sync with Upstash / Vercel KV if environment variables are provided.

import fs from "fs";
import path from "path";
import os from "os";
import { StorageAdapter } from "grammy";
import { UserSession } from "./session";

export class PersistentSessionStorage implements StorageAdapter<UserSession> {
  private cache: Map<string, UserSession> = new Map();
  private filePath: string;
  private isLoaded: boolean = false;
  private kvUrl?: string;
  private kvToken?: string;

  constructor() {
    // Determine storage file location
    if (process.env.SESSION_STORAGE_PATH) {
      this.filePath = process.env.SESSION_STORAGE_PATH;
    } else if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      this.filePath = path.join(os.tmpdir(), "seadrop_sniper_sessions.json");
    } else {
      this.filePath = path.join(process.cwd(), "sessions.json");
    }

    // Optional Upstash / Vercel KV REST integration
    this.kvUrl =
      process.env.KV_REST_API_URL ||
      process.env.UPSTASH_REDIS_REST_URL ||
      undefined;
    this.kvToken =
      process.env.KV_REST_API_TOKEN ||
      process.env.UPSTASH_REDIS_REST_TOKEN ||
      undefined;

    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (data && typeof data === "object") {
          for (const [k, v] of Object.entries(data)) {
            this.cache.set(k, v as UserSession);
          }
        }
      }
      this.isLoaded = true;
    } catch (err: any) {
      console.warn("⚠️ Could not load session from disk:", err.message);
      this.isLoaded = true;
    }
  }

  private persistToDisk() {
    try {
      const obj: Record<string, UserSession> = {};
      for (const [k, v] of this.cache.entries()) {
        obj[k] = v;
      }
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
    } catch (err: any) {
      console.error("⚠️ Failed to persist sessions to disk:", err.message);
    }
  }

  private async syncKv(key: string, value?: UserSession) {
    if (!this.kvUrl || !this.kvToken) return;

    try {
      if (value !== undefined) {
        await fetch(`${this.kvUrl}/set/${encodeURIComponent(key)}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.kvToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(JSON.stringify(value)),
        });
      } else {
        await fetch(`${this.kvUrl}/del/${encodeURIComponent(key)}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.kvToken}`,
          },
        });
      }
    } catch (err: any) {
      // Non-blocking KV sync failure
      console.warn("KV sync notice:", err.message);
    }
  }

  async read(key: string): Promise<UserSession | undefined> {
    if (!this.isLoaded) {
      this.loadFromDisk();
    }

    let val = this.cache.get(key);
    if (!val && this.kvUrl && this.kvToken) {
      try {
        const res = await fetch(
          `${this.kvUrl}/get/${encodeURIComponent(key)}`,
          {
            headers: { Authorization: `Bearer ${this.kvToken}` },
          },
        );
        const json = (await res.json()) as any;
        if (json?.result) {
          val = JSON.parse(json.result);
          if (val) {
            this.cache.set(key, val);
            this.persistToDisk();
          }
        }
      } catch {}
    }

    return val;
  }

  has(key: string): boolean {
    if (!this.isLoaded) {
      this.loadFromDisk();
    }
    return this.cache.has(key);
  }

  async write(key: string, value: UserSession): Promise<void> {
    this.cache.set(key, value);
    this.persistToDisk();
    if (this.kvUrl && this.kvToken) {
      this.syncKv(key, value).catch(() => {});
    }
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
    this.persistToDisk();
    if (this.kvUrl && this.kvToken) {
      this.syncKv(key, undefined).catch(() => {});
    }
  }

  readAllKeys(): string[] {
    if (!this.isLoaded) {
      this.loadFromDisk();
    }
    return Array.from(this.cache.keys());
  }

  readAllValues(): UserSession[] {
    if (!this.isLoaded) {
      this.loadFromDisk();
    }
    return Array.from(this.cache.values());
  }

  readAllEntries(): [string, UserSession][] {
    if (!this.isLoaded) {
      this.loadFromDisk();
    }
    return Array.from(this.cache.entries());
  }
}
