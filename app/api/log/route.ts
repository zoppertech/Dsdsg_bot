import { NextRequest, NextResponse } from "next/server";
import { detectLanguage, findConfirmQuestions } from "@/lib/conversationAnalysis";
import { cleanSessionId, errorMessage, logEvent } from "@/lib/events";
import { verifyLogTicket } from "@/lib/logTicket";
import { conversations, type LoggedTurn } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 100_000;
const MAX_TURNS = 300;
const MAX_TEXT = 4_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const END_REASONS = new Set(["user", "time", "idle", "hidden", "closed", "error"]);

// Saves one finished conversation (text only). Called with navigator.sendBeacon when a chat ends,
// so it also works when the user closes the page. We never read or store the IP address or location.
export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => "");
  if (!raw || raw.length > MAX_BODY_BYTES) return bad("Invalid body");

  let body: {
    ticket?: unknown;
    startTime?: unknown;
    endTime?: unknown;
    turns?: unknown;
    sessionId?: unknown;
    endReason?: unknown;
    connectMs?: unknown;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return bad("Invalid JSON");
  }

  // The ticket proves this conversation came from a real session we handed out, and says which bot.
  const ticket = verifyLogTicket(body.ticket);
  if (!ticket) {
    await logEvent({ type: "log_rejected", level: "warn", data: { reason: "invalid ticket" } });
    return NextResponse.json({ error: "Invalid ticket" }, { status: 403 });
  }
  const sessionId = cleanSessionId(body.sessionId);

  const now = Date.now();
  const start = Number(body.startTime);
  const end = Number(body.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return bad("Invalid times");
  if (start < ticket.issuedAt - CLOCK_SKEW_MS || end > now + CLOCK_SKEW_MS) return bad("Invalid times");

  if (!Array.isArray(body.turns)) return bad("Invalid turns");
  const turns: LoggedTurn[] = body.turns
    .slice(0, MAX_TURNS)
    .filter(
      (t): t is LoggedTurn =>
        !!t && typeof t === "object" && (t.role === "user" || t.role === "bot") && typeof t.text === "string",
    )
    .map((t) => ({ role: t.role, text: t.text.trim().slice(0, MAX_TEXT) }))
    .filter((t) => t.text);

  const userTurnCount = turns.filter((t) => t.role === "user").length;
  if (userTurnCount === 0) return NextResponse.json({ ok: true, skipped: true }); // nothing was asked

  const { flagged, questions } = findConfirmQuestions(turns);
  const endReason = typeof body.endReason === "string" && END_REASONS.has(body.endReason) ? body.endReason : undefined;
  const connectMs = Number(body.connectMs);
  const durationSeconds = Math.round((end - start) / 1000);

  try {
    const col = await conversations();
    await col.insertOne({
      bot: ticket.bot,
      ticketId: ticket.id,
      sessionId,
      startTime: new Date(start),
      endTime: new Date(end),
      durationSeconds,
      endReason,
      connectMs: Number.isFinite(connectMs) && connectMs >= 0 ? Math.min(Math.round(connectMs), 120_000) : undefined,
      turns,
      userTurnCount,
      language: detectLanguage(turns),
      saidWillConfirm: flagged,
      confirmQuestions: questions,
      createdAt: new Date(),
    });
    await logEvent({
      type: "log_saved",
      bot: ticket.bot,
      sessionId,
      data: { turns: turns.length, seconds: durationSeconds, willConfirm: flagged },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Same ticket sent twice (e.g. beacon retried): already saved, that's fine.
    if ((err as { code?: number })?.code === 11000) return NextResponse.json({ ok: true, duplicate: true });
    await logEvent({ type: "log_error", level: "error", bot: ticket.bot, sessionId, data: { message: errorMessage(err) } });
    return NextResponse.json({ error: "Couldn't save" }, { status: 500 });
  }
}

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}
