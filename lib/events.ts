import "server-only";
import type { BotId } from "@/lib/bots";
import { events, type EventDoc, type EventLevel } from "@/lib/mongodb";

export type NewEvent = {
  type: string;
  level?: EventLevel;
  source?: EventDoc["source"];
  bot?: BotId;
  sessionId?: string;
  data?: EventDoc["data"];
};

/**
 * Record an app event: one JSON line in the server log (visible in the hosting logs)
 * and one row in the "events" collection (visible on /admin/logs).
 * Never throws: logging must not break the app. Never put IPs, keys or user text in `data`.
 */
export async function logEvent(e: NewEvent): Promise<void> {
  const doc: EventDoc = { time: new Date(), level: e.level ?? "info", source: e.source ?? "server", ...e } as EventDoc;
  const line = JSON.stringify({ event: doc.type, level: doc.level, source: doc.source, bot: doc.bot, session: doc.sessionId, ...doc.data });
  if (doc.level === "error") console.error("[event]", line);
  else if (doc.level === "warn") console.warn("[event]", line);
  else console.log("[event]", line);
  try {
    await (await events()).insertOne(doc);
  } catch (err) {
    console.error("[event] could not save:", err instanceof Error ? err.message : "unknown error");
  }
}

export function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** Session ids are random UUIDs made in the browser. */
export function cleanSessionId(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}
