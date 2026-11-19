// Server-only settings for each bot. Never import this file from a client component.
import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Modality, StartSensitivity, type LiveConnectConfig } from "@google/genai";
import path from "node:path";

export type BotId = "customer" | "promoter";

type BotConfig = {
  promptFile: string;
  voiceEnv: string;
  maxMinutesEnv: string;
  defaultMaxMinutes: number;
};

export const BOTS: Record<BotId, BotConfig> = {
  customer: { promptFile: "customer.md", voiceEnv: "CUSTOMER_VOICE", maxMinutesEnv: "CUSTOMER_MAX_MINUTES", defaultMaxMinutes: 4 },
  promoter: { promptFile: "promoter.md", voiceEnv: "PROMOTER_VOICE", maxMinutesEnv: "PROMOTER_MAX_MINUTES", defaultMaxMinutes: 6 },
};

/** Sent to the browser with each token. `enabled: false` = no time limit and no idle timeout. */
export type SessionLimits = { enabled: boolean; maxMinutes: number; idleSeconds: number };

/** Read on every request, so changing .env.local only needs a server restart. Limits are OFF unless set to "true". */
export function sessionLimits(bot: BotId): SessionLimits {
  return {
    enabled: process.env.SESSION_LIMITS_ENABLED?.trim().toLowerCase() === "true",
    maxMinutes: positiveNumberEnv(BOTS[bot].maxMinutesEnv, BOTS[bot].defaultMaxMinutes),
    idleSeconds: positiveNumberEnv("IDLE_TIMEOUT_SECONDS", 30),
  };
}

function positiveNumberEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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

/** Short fingerprint of the current prompt text, so eval results can be compared across prompt versions. */
export async function promptVersion(bot: BotId): Promise<string> {
  return createHash("sha256").update(await loadPrompt(bot)).digest("hex").slice(0, 8);
}

/** The Gemini Live settings for a bot. Used by the browser token and by the server-side evaluation. */
export async function liveConfig(bot: BotId): Promise<LiveConnectConfig> {
  return {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: requireEnv(BOTS[bot].voiceEnv) } } },
    systemInstruction: await loadPrompt(bot),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Cost: Gemini re-bills the whole conversation on every turn. In long chats, once the context
    // passes ~14k tokens, drop the oldest turns down to ~9k (the system prompt is always kept).
    contextWindowCompression: { triggerTokens: "14000", slidingWindow: { targetTokens: "9000" } },
    // Hands-free: Gemini detects when the user stops talking and replies.
    // Low start sensitivity = background store noise is less likely to count as speech.
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
        prefixPaddingMs: 300,
        silenceDurationMs: 800,
      },
    },
  };
}
