import { GoogleGenAI, Modality, StartSensitivity } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { BOTS, isBotId, loadPrompt, requireEnv } from "@/lib/bots";
import { isPromoterSecret } from "@/lib/promoterAccess";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tokens are created on v1beta (per Google's Live API docs). The browser SDK
// connects with v1alpha, which works with these tokens and avoids an SDK warning.
const SERVER_API_VERSION = "v1beta";
const CLIENT_API_VERSION = "v1alpha";

export async function POST(req: NextRequest) {
  const bot = req.nextUrl.searchParams.get("bot");
  if (!isBotId(bot)) {
    return NextResponse.json({ error: "Unknown bot" }, { status: 400 });
  }

  // The promoter bot only works from its secret page, which sends the secret in the body.
  if (bot === "promoter") {
    const body = await req.json().catch(() => null);
    if (!isPromoterSecret(body?.secret)) {
      return NextResponse.json({ error: "Not available" }, { status: 403 });
    }
  }

  // 5 new sessions per minute per IP, counted separately for each bot.
  if (!rateLimit(`${bot}:${clientIp(req.headers)}`, 5, 60_000)) {
    return NextResponse.json({ error: "Too many attempts. Please try again in a minute." }, { status: 429 });
  }

  try {
    const model = requireEnv("GEMINI_LIVE_MODEL");
    const voiceName = requireEnv(BOTS[bot].voiceEnv);
    const systemInstruction = await loadPrompt(bot);
    const ai = new GoogleGenAI({
      apiKey: requireEnv("GEMINI_API_KEY"),
      httpOptions: { apiVersion: SERVER_API_VERSION },
    });

    const now = Date.now();
    const sessionMs = BOTS[bot].maxSessionMinutes * 60_000;

    const token = await ai.authTokens.create({
      config: {
        uses: 1, // single-use
        newSessionExpireTime: new Date(now + 60_000).toISOString(), // must connect within 1 minute
        expireTime: new Date(now + sessionMs + 60_000).toISOString(), // hard stop shortly after the session limit
        liveConnectConstraints: {
          model,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
            systemInstruction,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
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
          },
        },
        // Empty list = lock every field set above, so the browser cannot change them.
        lockAdditionalFields: [],
      },
    });

    if (!token.name) throw new Error("Token response had no name");

    return NextResponse.json(
      { token: token.name, model, apiVersion: CLIENT_API_VERSION, maxSessionMinutes: BOTS[bot].maxSessionMinutes },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // Log only the message: never the key or the full request.
    console.error("[api/token] failed:", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Couldn't connect right now. Please try again." }, { status: 500 });
  }
}
