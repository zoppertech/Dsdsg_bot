import { GoogleGenAI } from "@google/genai";
import { after, NextRequest, NextResponse } from "next/server";
import { isBotId, liveConfig, requireEnv, sessionLimits } from "@/lib/bots";
import { cleanSessionId, errorMessage, logEvent } from "@/lib/events";
import { createLogTicket } from "@/lib/logTicket";
import { isPromoterSecret } from "@/lib/promoterAccess";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tokens are created on v1beta (per Google's Live API docs). The browser SDK
// connects with v1alpha, which works with these tokens and avoids an SDK warning.
const SERVER_API_VERSION = "v1beta";
const CLIENT_API_VERSION = "v1alpha";

// With limits OFF the token still needs an end time. Gemini Live itself closes audio
// sessions after about 15 minutes, so this is only an outer safety cap.
const NO_LIMIT_TOKEN_MINUTES = 60;

export async function POST(req: NextRequest) {
  const bot = req.nextUrl.searchParams.get("bot");
  if (!isBotId(bot)) {
    return NextResponse.json({ error: "Unknown bot" }, { status: 400 });
  }
  const sessionId = cleanSessionId(req.nextUrl.searchParams.get("sid"));
  // Events are written after the response is sent, so logging never slows down connecting.
  const track = (type: string, level: "info" | "warn" | "error", data?: Record<string, string | number>) =>
    after(() => logEvent({ type, level, bot, sessionId, data }));

  // The promoter bot only works from its secret page, which sends the secret in the body.
  if (bot === "promoter") {
    const body = await req.json().catch(() => null);
    if (!isPromoterSecret(body?.secret)) {
      track("token_forbidden", "warn");
      return NextResponse.json({ error: "Not available" }, { status: 403 });
    }
  }

  // 5 new sessions per minute per IP, counted separately for each bot.
  if (!rateLimit(`${bot}:${clientIp(req.headers)}`, 5, 60_000)) {
    track("token_rate_limited", "warn");
    return NextResponse.json({ error: "Too many attempts. Please try again in a minute." }, { status: 429 });
  }

  try {
    const model = requireEnv("GEMINI_LIVE_MODEL");
    const ai = new GoogleGenAI({
      apiKey: requireEnv("GEMINI_API_KEY"),
      httpOptions: { apiVersion: SERVER_API_VERSION },
    });

    const now = Date.now();
    const limits = sessionLimits(bot);
    const sessionMs = (limits.enabled ? limits.maxMinutes : NO_LIMIT_TOKEN_MINUTES) * 60_000;

    const token = await ai.authTokens.create({
      config: {
        uses: 1, // single-use
        newSessionExpireTime: new Date(now + 60_000).toISOString(), // must connect within 1 minute
        expireTime: new Date(now + sessionMs + 60_000).toISOString(), // hard stop shortly after the session limit
        liveConnectConstraints: { model, config: await liveConfig(bot) },
        // Empty list = lock every field set above, so the browser cannot change them.
        lockAdditionalFields: [],
      },
    });

    if (!token.name) throw new Error("Token response had no name");

    track("token_issued", "info", { ms: Date.now() - now });
    return NextResponse.json(
      // logTicket lets the browser save this conversation's transcript via /api/log when it ends.
      { token: token.name, model, apiVersion: CLIENT_API_VERSION, limits, logTicket: createLogTicket(bot) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // Log only the message: never the key or the full request.
    track("token_error", "error", { message: errorMessage(err) });
    return NextResponse.json({ error: "Couldn't connect right now. Please try again." }, { status: 500 });
  }
}
