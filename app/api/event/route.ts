import { NextRequest, NextResponse } from "next/server";
import { isBotId } from "@/lib/bots";
import { cleanSessionId, logEvent } from "@/lib/events";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Events the browser may report, and the fields each one may carry. Anything else is dropped.
const ALLOWED: Record<string, Record<string, "number" | "string">> = {
  session_connected: { connectMs: "number" },
  session_ended: { reason: "string", seconds: "number" },
  connect_failed: { kind: "string", message: "string" },
  connection_dropped: { phase: "string", code: "number", reason: "string" },
};

// Receives browser events (sent with navigator.sendBeacon). No IP or location is stored.
export async function POST(req: NextRequest) {
  // The IP is used only for this in-memory limit, never saved.
  if (!rateLimit(`event:${clientIp(req.headers)}`, 30, 60_000)) return new NextResponse(null, { status: 429 });

  const raw = await req.text().catch(() => "");
  if (!raw || raw.length > 4_000) return new NextResponse(null, { status: 400 });
  let body: { type?: unknown; bot?: unknown; sessionId?: unknown; data?: Record<string, unknown> };
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const type = typeof body.type === "string" ? body.type : "";
  const fields = ALLOWED[type];
  const bot = typeof body.bot === "string" ? body.bot : null;
  if (!fields || !isBotId(bot)) return new NextResponse(null, { status: 400 });

  const data: Record<string, string | number> = {};
  for (const [key, kind] of Object.entries(fields)) {
    const v = body.data?.[key];
    if (kind === "number" && typeof v === "number" && Number.isFinite(v)) data[key] = Math.max(0, Math.min(Math.round(v), 86_400_000));
    if (kind === "string" && typeof v === "string") data[key] = v.slice(0, 200);
  }

  const level =
    type === "connect_failed"
      ? data.kind === "mic_denied" || data.kind === "mic_missing"
        ? "warn" // the user's choice or device, not our bug
        : "error"
      : type === "connection_dropped"
        ? "error"
        : "info";

  await logEvent({ type, level, source: "client", bot, sessionId: cleanSessionId(body.sessionId), data });
  return new NextResponse(null, { status: 204 });
}
