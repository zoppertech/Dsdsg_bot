import "server-only";
import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import type { BotId } from "@/lib/bots";

// ---------- document types ----------
export type LoggedTurn = { role: "user" | "bot"; text: string };
/** `key` is a normalised copy of `text`, used to group the same question asked in slightly different ways. */
export type ConfirmQuestion = { text: string; key: string };

/** Judge scores are 1–5. */
export type Scores = { accuracy: number; completeness: number; relevance: number; languageMatch: boolean };

export type ConversationEval = Scores & {
  at: Date;
  judgeModel: string;
  promptVersion: string;
  /** `turn` = index into `turns`. */
  issues: { turn: number; problem: string }[];
  summary: string;
};

export type ConversationDoc = {
  bot: BotId;
  /** One-time id from the log ticket: stops the same conversation being saved twice. */
  ticketId: string;
  /** Links this conversation to its entries in `events`. */
  sessionId?: string;
  startTime: Date;
  endTime: Date;
  durationSeconds: number;
  endReason?: string;
  connectMs?: number;
  turns: LoggedTurn[];
  userTurnCount: number;
  language: string;
  saidWillConfirm: boolean;
  /** The user questions the bot answered with "I'll confirm with the team". */
  confirmQuestions: ConfirmQuestion[];
  createdAt: Date;
  eval?: ConversationEval;
};

export type EventLevel = "info" | "warn" | "error";
export type EventDoc = {
  time: Date;
  type: string;
  level: EventLevel;
  source: "server" | "client";
  bot?: BotId;
  sessionId?: string;
  data?: Record<string, string | number | boolean | null>;
};

export type GoldenResult = Scores & {
  itemId: string;
  bot: BotId;
  language: string;
  question: string;
  expected: string;
  answer: string;
  answerMs: number;
  expectConfirm?: boolean;
  saidWillConfirm: boolean;
  pass: boolean;
  hallucinations: string[];
  missing: string[];
  reason: string;
  error?: string;
};

export type RunSummary = {
  accuracy: number;
  completeness: number;
  relevance: number;
  languageMatchRate: number;
  passRate: number;
  count: number;
  errors: number;
};

export type EvalRunDoc = {
  startedAt: Date;
  finishedAt?: Date;
  status: "running" | "done";
  /** True when only some questions were run (e.g. re-running the failed ones). Not used as a baseline. */
  partial?: boolean;
  bots: BotId[];
  itemIds: string[];
  promptVersions: Partial<Record<BotId, string>>;
  liveModel: string;
  judgeModel: string;
  results: GoldenResult[];
  summary?: RunSummary;
};

// ---------- connection ----------
// Cached on globalThis so dev hot-reloads and warm serverless invocations reuse one
// connection pool instead of opening a new one on every request.
type Cache = { client?: Promise<MongoClient>; indexes: Map<string, Promise<unknown>> };
const g = globalThis as typeof globalThis & { __mongo?: Cache };
const cache: Cache = (g.__mongo ??= { indexes: new Map() });
cache.indexes ??= new Map(); // older cache shape after a hot reload

function uri(): string {
  // MONGODB_URI is preferred; DATABASE_URL is accepted as a fallback.
  const value = process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!value) throw new Error("Missing environment variable MONGODB_URI");
  return value;
}

async function db(): Promise<Db> {
  if (!cache.client) {
    // Small pool: serverless instances each hold their own.
    cache.client = new MongoClient(uri(), { maxPoolSize: 5, serverSelectionTimeoutMS: 8_000, ignoreUndefined: true }).connect();
    cache.client.catch(() => {
      cache.client = undefined; // don't cache a failed connection; retry on the next request
    });
  }
  const client = await cache.client;
  const name = process.env.MONGODB_DB;
  if (!name) throw new Error("Missing environment variable MONGODB_DB");
  return client.db(name);
}

type IndexSpec = { key: Record<string, 1 | -1>; name: string; unique?: boolean; sparse?: boolean };

const INDEXES: Record<string, IndexSpec[]> = {
  conversations: [
    { key: { bot: 1 }, name: "bot_1" },
    { key: { startTime: -1 }, name: "startTime_-1" },
    { key: { ticketId: 1 }, name: "ticketId_1", unique: true },
    { key: { sessionId: 1 }, name: "sessionId_1", sparse: true },
  ],
  events: [
    { key: { time: -1 }, name: "time_-1" },
    { key: { type: 1, time: -1 }, name: "type_1_time_-1" },
    { key: { level: 1, time: -1 }, name: "level_1_time_-1" },
    { key: { sessionId: 1 }, name: "sessionId_1", sparse: true },
  ],
  eval_runs: [{ key: { startedAt: -1 }, name: "startedAt_-1" }],
};

async function collection<T extends Document>(name: string): Promise<Collection<T>> {
  const col = (await db()).collection<T>(name);
  // Create indexes once per process (a no-op if they already exist).
  if (!cache.indexes.has(name)) {
    cache.indexes.set(
      name,
      col.createIndexes(INDEXES[name] ?? []).catch((err) => {
        cache.indexes.delete(name);
        console.error(`[mongodb] index creation failed for ${name}:`, err instanceof Error ? err.message : "unknown error");
      }),
    );
  }
  await cache.indexes.get(name);
  return col;
}

export const conversations = () => collection<ConversationDoc>("conversations");
export const events = () => collection<EventDoc>("events");
export const evalRuns = () => collection<EvalRunDoc>("eval_runs");
