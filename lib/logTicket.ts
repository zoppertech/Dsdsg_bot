import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isBotId, requireEnv, type BotId } from "@/lib/bots";

// A "log ticket" is handed out with each Gemini token. /api/log only accepts a conversation
// that carries a valid, unused ticket, so random people can't fill the database with junk
// (tickets come from the rate-limited token route, and each one can be saved only once).

const MAX_AGE_MS = 2 * 60 * 60_000; // a conversation must be saved within 2 hours of starting

function key(): Buffer {
  // Derived from the Gemini key so no extra secret is needed; it never leaves the server.
  return createHmac("sha256", requireEnv("GEMINI_API_KEY")).update("dsdsg-log-ticket-v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

export function createLogTicket(bot: BotId): string {
  const payload = Buffer.from(JSON.stringify({ b: bot, t: Date.now(), n: randomUUID() })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export type Ticket = { bot: BotId; issuedAt: number; id: string };

export function verifyLogTicket(ticket: unknown): Ticket | null {
  if (typeof ticket !== "string" || ticket.length > 400) return null;
  const [payload, mac] = ticket.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isBotId(data.b) || typeof data.t !== "number" || typeof data.n !== "string") return null;
    if (Date.now() - data.t > MAX_AGE_MS) return null;
    return { bot: data.b, issuedAt: data.t, id: data.n };
  } catch {
    return null;
  }
}
