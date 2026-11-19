import "server-only";
import { GoogleGenAI, ThinkingLevel, Type, type Schema } from "@google/genai";
import golden from "@/evals/golden-set.json";
import { isBotId, liveConfig, loadPrompt, requireEnv, type BotId } from "@/lib/bots";
import { saysWillConfirm } from "@/lib/conversationAnalysis";
import type { ConversationDoc, ConversationEval, GoldenResult, RunSummary, Scores } from "@/lib/mongodb";

// ---------- golden test set ----------
export type GoldenItem = {
  id: string;
  bot: BotId;
  language: string;
  question: string;
  expected: string;
  expectConfirm?: boolean;
};

export const GOLDEN_ITEMS: GoldenItem[] = (golden.items as GoldenItem[]).filter((i) => isBotId(i.bot));

export function judgeModel(): string {
  return process.env.GEMINI_JUDGE_MODEL || "gemini-3.8-flash";
}

function genai(apiVersion?: string) {
  return new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY"), httpOptions: apiVersion ? { apiVersion } : undefined });
}

// ---------- ask the real voice bot (same model + prompt as the app) ----------
const ASK_TIMEOUT_MS = 45_000;

/** Send one text question to the Live bot and return what it said (its speech transcript). */
export async function askLiveBot(bot: BotId, question: string): Promise<{ answer: string; ms: number }> {
  const started = Date.now();
  let answer = "";
  let setupDone!: () => void;
  let finish!: () => void;
  let fail!: (err: Error) => void;
  const setup = new Promise<void>((r) => (setupDone = r));
  const done = new Promise<void>((res, rej) => {
    finish = res;
    fail = rej;
  });
  done.catch(() => {}); // handled where awaited

  const session = await genai("v1beta").live.connect({
    model: requireEnv("GEMINI_LIVE_MODEL"),
    config: await liveConfig(bot),
    callbacks: {
      onmessage: (m) => {
        if (m.setupComplete) setupDone();
        const sc = m.serverContent;
        if (sc?.outputTranscription?.text) answer += sc.outputTranscription.text;
        if (sc?.turnComplete) finish();
      },
      onerror: (e) => fail(new Error(`Live error: ${e?.message ?? "unknown"}`)),
      onclose: (e) => fail(new Error(`Live closed early (${e?.code ?? "?"} ${e?.reason ?? ""})`)),
    },
  });
  const timer = setTimeout(() => fail(new Error("Live bot did not answer in 45 s")), ASK_TIMEOUT_MS);
  try {
    await Promise.race([setup, done]);
    session.sendRealtimeInput({ text: question });
    await done;
  } finally {
    clearTimeout(timer);
    try {
      session.close();
    } catch {}
  }
  return { answer: answer.replace(/\s+/g, " ").trim(), ms: Date.now() - started };
}

// ---------- judge ----------
const RUBRIC = `You are a strict quality evaluator for a Zopper voice assistant used at Croma stores in India.
The assistant must answer ONLY from its KNOWLEDGE BASE. Its replies are spoken, so they are short (2–4 sentences);
do not penalise a reply for leaving out detail beyond the key points.
Score each metric as an integer from 1 to 5:
- accuracy: every factual claim (prices, coverage, processes, numbers, contacts) is supported by the KNOWLEDGE BASE.
  5 = fully correct; 4 = correct with a tiny imprecision; 3 = one noticeable error or vague claim;
  2 = a clear wrong fact; 1 = several wrong/invented facts, a guess about something the knowledge base says not to guess,
  or something the knowledge base forbids (e.g. "everything is covered", calculating a payout, sharing another store's data).
- completeness: covers the key points the user needed (for golden tests: the EXPECTED key points). 5 = all; 1 = none.
- relevance: answers what was asked, without off-topic content. 5 = fully on point; 1 = unrelated.
- languageMatch: true if the reply is in the required language. Hinglish = Hindi written in Latin letters mixed with English.
  Hindi in Devanagari and Hindi in Latin letters are both Hindi. Marathi replied in Hindi = false.
Speech transcripts may contain small recognition mistakes (spelling, numbers written as words): ignore those.
Prices spoken as words (e.g. "satrah sau ninyaanve") equal the digits (₹1,799).
Write all explanations in short, plain English.`;

const scoreProps: Record<string, Schema> = {
  accuracy: { type: Type.INTEGER },
  completeness: { type: Type.INTEGER },
  relevance: { type: Type.INTEGER },
  languageMatch: { type: Type.BOOLEAN },
};

const GOLDEN_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    ...scoreProps,
    hallucinations: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Claims not supported by the knowledge base" },
    missing: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Expected key points the answer left out" },
    deferredToTeam: {
      type: Type.BOOLEAN,
      description: "True if the assistant said (in any language or wording) that it will confirm / check with the team instead of answering",
    },
    reason: { type: Type.STRING, description: "One sentence" },
  },
  required: ["accuracy", "completeness", "relevance", "languageMatch", "hallucinations", "missing", "deferredToTeam", "reason"],
};

const CHAT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    ...scoreProps,
    issues: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { turn: { type: Type.INTEGER }, problem: { type: Type.STRING } },
        required: ["turn", "problem"],
      },
      description: "Problems in specific assistant turns (turn = the [number] shown in the transcript)",
    },
    summary: { type: Type.STRING, description: "One or two sentences" },
  },
  required: ["accuracy", "completeness", "relevance", "languageMatch", "issues", "summary"],
};

async function judge<T>(prompt: string, schema: Schema): Promise<T> {
  const res = await genai().models.generateContent({
    model: judgeModel(),
    contents: prompt,
    config: {
      systemInstruction: RUBRIC,
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: schema,
      // Cost: low thinking gave the same verdicts in testing with 0 thinking tokens (billed as output).
      ...(judgeModel().startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
    },
  });
  if (!res.text) throw new Error("Judge returned no text");
  return JSON.parse(res.text) as T;
}

const clamp = (n: unknown) => Math.max(1, Math.min(5, Math.round(Number(n) || 1)));
const strings = (v: unknown, max = 5) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, max).map((x: string) => x.slice(0, 300)) : [];

function cleanScores(raw: Partial<Scores>): Scores {
  return {
    accuracy: clamp(raw.accuracy),
    completeness: clamp(raw.completeness),
    relevance: clamp(raw.relevance),
    languageMatch: raw.languageMatch === true,
  };
}

/** Run one golden item end to end: ask the bot, then judge the answer against the expected key points. */
export async function evaluateGoldenItem(item: GoldenItem): Promise<GoldenResult> {
  const base = {
    itemId: item.id,
    bot: item.bot,
    language: item.language,
    question: item.question,
    expected: item.expected,
    expectConfirm: item.expectConfirm,
  };
  let answer = "";
  let answerMs = 0;
  try {
    ({ answer, ms: answerMs } = await askLiveBot(item.bot, item.question));
    if (!answer) throw new Error("The bot gave an empty answer");

    const kb = await loadPrompt(item.bot);
    const raw = await judge<Partial<Scores> & { hallucinations?: unknown; missing?: unknown; deferredToTeam?: unknown; reason?: unknown }>(
      `KNOWLEDGE BASE:\n<<<\n${kb}\n>>>\n\nREQUIRED REPLY LANGUAGE: ${item.language}\n\nUSER QUESTION:\n${item.question}\n\nEXPECTED KEY POINTS:\n${item.expected}\n\nASSISTANT ANSWER (speech transcript):\n${answer}`,
      GOLDEN_SCHEMA,
    );
    const scores = cleanScores(raw);
    // Phrase match catches the usual wording; the judge also catches other languages and paraphrases.
    const saidWillConfirm = saysWillConfirm(answer) || raw.deferredToTeam === true;
    const confirmOk = item.expectConfirm === undefined || item.expectConfirm === saidWillConfirm;
    return {
      ...base,
      ...scores,
      answer,
      answerMs,
      saidWillConfirm,
      pass: scores.accuracy >= 4 && scores.relevance >= 4 && scores.completeness >= 3 && scores.languageMatch && confirmOk,
      hallucinations: strings(raw.hallucinations),
      missing: strings(raw.missing),
      reason:
        (typeof raw.reason === "string" ? raw.reason.slice(0, 400) : "") +
        (confirmOk ? "" : item.expectConfirm ? " [Expected: should have said it will confirm with the team.]" : " [Said it will confirm with the team, but the answer is in the knowledge base.]"),
    };
  } catch (err) {
    return {
      ...base,
      accuracy: 0,
      completeness: 0,
      relevance: 0,
      languageMatch: false,
      answer,
      answerMs,
      saidWillConfirm: false,
      pass: false,
      hallucinations: [],
      missing: [],
      reason: "",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}

export function summarize(results: GoldenResult[]): RunSummary {
  const ok = results.filter((r) => !r.error);
  const avg = (f: (r: GoldenResult) => number) => (ok.length ? ok.reduce((s, r) => s + f(r), 0) / ok.length : 0);
  return {
    accuracy: avg((r) => r.accuracy),
    completeness: avg((r) => r.completeness),
    relevance: avg((r) => r.relevance),
    languageMatchRate: avg((r) => (r.languageMatch ? 1 : 0)),
    passRate: results.length ? results.filter((r) => r.pass).length / results.length : 0,
    count: results.length,
    errors: results.length - ok.length,
  };
}

/** Score a real saved conversation against the knowledge base. */
export async function evaluateConversation(c: ConversationDoc, promptVersion: string): Promise<ConversationEval> {
  const kb = await loadPrompt(c.bot);
  const transcript = c.turns.map((t, i) => `[${i}] ${t.role === "user" ? "USER" : "ASSISTANT"}: ${t.text}`).join("\n");
  const raw = await judge<Partial<Scores> & { issues?: unknown; summary?: unknown }>(
    `KNOWLEDGE BASE:\n<<<\n${kb}\n>>>\n\nThis is a real conversation. Score the ASSISTANT's replies overall.
REQUIRED REPLY LANGUAGE: the same language as the user's message just before each reply.
For completeness: did the assistant answer everything the user asked?
The user's words are a speech transcript and may be misheard; do not blame the assistant for that.

TRANSCRIPT:\n${transcript}`,
    CHAT_SCHEMA,
  );
  const issues = Array.isArray(raw.issues)
    ? raw.issues
        .filter((x): x is { turn: number; problem: string } => !!x && typeof x.problem === "string")
        .slice(0, 10)
        .map((x) => ({ turn: Number(x.turn) || 0, problem: x.problem.slice(0, 300) }))
    : [];
  return {
    ...cleanScores(raw),
    issues,
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 500) : "",
    at: new Date(),
    judgeModel: judgeModel(),
    promptVersion,
  };
}
