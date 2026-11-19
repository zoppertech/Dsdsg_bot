// Server-only settings for each bot. Never import this file from a client component.
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type BotId = "customer" | "promoter";

type BotConfig = {
  promptFile: string;
  voiceEnv: string;
  maxSessionMinutes: number;
};

export const BOTS: Record<BotId, BotConfig> = {
  customer: { promptFile: "customer.md", voiceEnv: "CUSTOMER_VOICE", maxSessionMinutes: 4 },
  promoter: { promptFile: "promoter.md", voiceEnv: "PROMOTER_VOICE", maxSessionMinutes: 6 },
};

export function isBotId(value: string | null): value is BotId {
  return value === "customer" || value === "promoter";
}

const promptCache = new Map<BotId, string>();

export async function loadPrompt(bot: BotId): Promise<string> {
  // In development, always re-read so edits to prompts/*.md show up without restarting.
  const cached = process.env.NODE_ENV === "production" ? promptCache.get(bot) : undefined;
  if (cached) return cached;
  const text = await readFile(path.join(process.cwd(), "prompts", BOTS[bot].promptFile), "utf8");
  promptCache.set(bot, text);
  return text;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
