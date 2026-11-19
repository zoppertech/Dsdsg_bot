"use client";

import type { LiveServerMessage, Session } from "@google/genai";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PcmPlayer, int16ToBase64 } from "@/lib/audioPlayer";
import { HELPLINE_DISPLAY, HELPLINE_TEL, type BotUi } from "@/lib/botUi";

type Phase = "start" | "connecting" | "live" | "ended" | "error";
type Activity = "listening" | "thinking" | "speaking";
type Turn = { id: number; role: "user" | "bot"; text: string };
type EndReason = "user" | "time" | "idle" | "hidden" | "closed";

// ---------- cost controls ----------
// Gemini re-bills the whole conversation (prompt + all audio so far) on every turn,
// so every second of audio we DON'T send saves money on every later turn too.
const IDLE_LIMIT_MS = 30_000; // end if nobody speaks or types for 30 s
const WARN_BEFORE_MS = 60_000; // show "ending soon" 1 minute before the limit
const HIDDEN_GRACE_MS = 3_000; // end if the user leaves the page / locks the phone
const GATE_MIN_LEVEL = 0.015; // mic level that counts as speech (0..1)
const GATE_HANGOVER_MS = 1_500; // keep sending this long after speech so Gemini notices the pause
const PREROLL_CHUNKS = 3; // also send the 300 ms before speech was detected (first word isn't cut)

const END_NOTES: Record<EndReason, string> = {
  user: "",
  time: "This chat reached its time limit.",
  idle: "This chat ended because it was quiet for a while.",
  hidden: "This chat ended when you left the page.",
  closed: "",
};

export default function VoiceBot({ ui, secret }: { ui: BotUi; secret?: string }) {
  const [phase, setPhase] = useState<Phase>("start");
  const [activity, setActivity] = useState<Activity>("listening");
  const [micOn, setMicOn] = useState(true);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [endReason, setEndReason] = useState<EndReason>("user");
  const [endingSoon, setEndingSoon] = useState(false);

  // Cost-control refs
  const maxSessionMs = useRef(4 * 60_000);
  const deadline = useRef(0);
  const lastActivity = useRef(0);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const hiddenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gateOpen = useRef(false);
  const lastLoud = useRef(0);
  const noiseFloor = useRef(0.005);
  const preRoll = useRef<ArrayBuffer[]>([]);

  // Refs hold live values that audio callbacks read (state would be stale there).
  const sessionRef = useRef<Session | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const phaseRef = useRef<Phase>("start");
  const activityRef = useRef<Activity>("listening");
  const micOnRef = useRef(true);
  const botTurnActive = useRef(false); // bot is replying: don't send mic audio (stops it hearing itself)
  const generating = useRef(false); // Gemini is still producing the current reply
  const turnDone = useRef(false); // Gemini finished producing the current reply
  const dropAudio = useRef(false); // user interrupted: ignore the rest of the current reply
  const pendingQuestion = useRef<string | null>(null);
  const thinkingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextId = useRef(1);
  const userTurnId = useRef<number | null>(null);
  const botTurnId = useRef<number | null>(null);
  const orbRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };
  const setActivityBoth = (a: Activity) => {
    activityRef.current = a;
    setActivity(a);
  };

  // ---------- transcript ----------
  const appendText = (role: Turn["role"], text: string) => {
    if (!text) return;
    const idRef = role === "user" ? userTurnId : botTurnId;
    const id = idRef.current;
    if (id === null) {
      const newId = nextId.current++;
      idRef.current = newId;
      setTurns((prev) => [...prev, { id: newId, role, text: text.trimStart() }]);
    } else {
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, text: t.text + text } : t)));
    }
  };

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns, activity]);

  // ---------- session lifecycle ----------
  const cleanup = () => {
    if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
    if (tickTimer.current) clearInterval(tickTimer.current);
    if (hiddenTimer.current) clearTimeout(hiddenTimer.current);
    tickTimer.current = null;
    gateOpen.current = false;
    preRoll.current = [];
    const session = sessionRef.current;
    sessionRef.current = null;
    try {
      session?.close();
    } catch {}
    playerRef.current?.stop();
    workletRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
  };

  useEffect(() => cleanup, []);

  // End the session if the user leaves the page or locks the phone (no paying for an unattended session).
  useEffect(() => {
    const onVisibility = () => {
      if (hiddenTimer.current) clearTimeout(hiddenTimer.current);
      const active = phaseRef.current === "live" || phaseRef.current === "connecting";
      if (document.hidden && active) hiddenTimer.current = setTimeout(() => end("hidden"), HIDDEN_GRACE_MS);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Runs every second during a session: time limit, "ending soon" warning, idle timeout. */
  const startTicking = () => {
    const now = Date.now();
    deadline.current = now + maxSessionMs.current;
    lastActivity.current = now;
    if (tickTimer.current) clearInterval(tickTimer.current);
    tickTimer.current = setInterval(() => {
      if (phaseRef.current !== "live") return;
      const t = Date.now();
      const left = deadline.current - t;
      if (left <= 0) return end("time");
      if (left <= WARN_BEFORE_MS) setEndingSoon(true);
      const quiet = activityRef.current === "listening" && !botTurnActive.current && !gateOpen.current;
      if (quiet && t - lastActivity.current > IDLE_LIMIT_MS) end("idle");
    }, 1000);
  };

  const finishBotTurn = () => {
    lastActivity.current = Date.now(); // idle countdown starts after the bot finishes talking
    botTurnActive.current = false;
    userTurnId.current = null;
    botTurnId.current = null;
    setActivityBoth("listening");
  };

  /** Stop the bot mid-reply (user tapped the orb or typed a new question). */
  const interruptBot = () => {
    playerRef.current?.stop();
    if (generating.current) dropAudio.current = true;
    botTurnActive.current = false;
    botTurnId.current = null;
    userTurnId.current = null;
  };

  const handleMessage = (msg: LiveServerMessage) => {
    if (msg.setupComplete) {
      setPhaseBoth("live");
      startTicking();
      const q = pendingQuestion.current;
      pendingQuestion.current = null;
      if (q) {
        appendText("user", q);
        userTurnId.current = null;
      }
      // With no question, "Hello" makes the bot say its opening line first.
      sessionRef.current?.sendRealtimeInput({ text: q ?? "Hello" });
      setActivityBoth("thinking");
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      playerRef.current?.stop();
      generating.current = false;
      dropAudio.current = false;
      finishBotTurn();
    }

    for (const part of sc.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (!data || !part.inlineData?.mimeType?.startsWith("audio/") || dropAudio.current) continue;
      generating.current = true;
      turnDone.current = false;
      botTurnActive.current = true;
      if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
      playerRef.current?.enqueue(data);
      if (activityRef.current !== "speaking") setActivityBoth("speaking");
    }

    if (sc.inputTranscription?.text) {
      appendText("user", sc.inputTranscription.text);
      // User is talking; if they pause and no reply has started yet, show "thinking".
      if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
      thinkingTimer.current = setTimeout(() => {
        if (activityRef.current === "listening" && !botTurnActive.current) setActivityBoth("thinking");
      }, 900);
    }
    if (sc.outputTranscription?.text && !dropAudio.current) appendText("bot", sc.outputTranscription.text);

    if (sc.turnComplete) {
      generating.current = false;
      if (dropAudio.current) {
        dropAudio.current = false; // the interrupted reply is over; next one plays normally
        return;
      }
      turnDone.current = true;
      if (!playerRef.current?.playing) finishBotTurn();
    }
  };

  const start = async (question?: string) => {
    setError("");
    setTurns([]);
    setDraft("");
    userTurnId.current = null;
    botTurnId.current = null;
    botTurnActive.current = false;
    generating.current = false;
    dropAudio.current = false;
    pendingQuestion.current = question ?? null;
    gateOpen.current = false;
    preRoll.current = [];
    noiseFloor.current = 0.005;
    setEndingSoon(false);
    setEndReason("user");
    micOnRef.current = true;
    setMicOn(true);
    setActivityBoth("thinking");
    setPhaseBoth("connecting");

    try {
      // 1) Audio must be created inside the tap, or mobile browsers keep it silent.
      const AC: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      ctxRef.current = ctx;
      await ctx.resume();

      // 2) Microphone.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      streamRef.current = stream;

      await ctx.audioWorklet.addModule("/worklets/capture-worklet.js");
      const worklet = new AudioWorkletNode(ctx, "capture-processor");
      workletRef.current = worklet;
      const mute = ctx.createGain();
      mute.gain.value = 0;
      ctx.createMediaStreamSource(stream).connect(worklet).connect(mute).connect(ctx.destination);

      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        const session = sessionRef.current;
        const listening = !!session && micOnRef.current && !botTurnActive.current && phaseRef.current === "live";

        const pcm = new Int16Array(e.data);
        let sum = 0;
        for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i];
        const level = Math.sqrt(sum / (pcm.length / 4)) / 32768;
        // Make the orb react to the user's voice.
        orbRef.current?.style.setProperty("--level", listening ? Math.min(1, level * 6).toFixed(2) : "0");

        const send = (buf: ArrayBuffer) =>
          session?.sendRealtimeInput({ audio: { data: int16ToBase64(buf), mimeType: "audio/pcm;rate=16000" } });

        if (!listening) {
          if (gateOpen.current) {
            gateOpen.current = false;
            session?.sendRealtimeInput({ audioStreamEnd: true });
          }
          preRoll.current = [];
          return;
        }

        // Voice gate: stream audio only while someone is speaking (silence is never sent).
        const now = Date.now();
        const loud = level > Math.max(GATE_MIN_LEVEL, noiseFloor.current * 3);
        if (!gateOpen.current) {
          if (!loud) noiseFloor.current = noiseFloor.current * 0.95 + level * 0.05; // learn background noise
          preRoll.current.push(e.data);
          if (preRoll.current.length > PREROLL_CHUNKS) preRoll.current.shift();
          if (loud) {
            gateOpen.current = true;
            lastLoud.current = now;
            lastActivity.current = now;
            preRoll.current.forEach(send);
            preRoll.current = [];
          }
        } else {
          send(e.data);
          if (loud) {
            lastLoud.current = now;
            lastActivity.current = now;
          } else if (now - lastLoud.current > GATE_HANGOVER_MS) {
            gateOpen.current = false;
            session.sendRealtimeInput({ audioStreamEnd: true }); // tells Gemini the mic paused
          }
        }
      };

      playerRef.current = new PcmPlayer(ctx, () => {
        if (turnDone.current) finishBotTurn();
      });

      // 3) Short-lived token from our server (the real API key never reaches the phone).
      const res = await fetch(`/api/token?bot=${ui.bot}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(secret ? { secret } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Couldn't connect. Please try again.");
      if (body.maxSessionMinutes) maxSessionMs.current = body.maxSessionMinutes * 60_000;

      // 4) Connect to Gemini Live. All settings are locked inside the token.
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: body.token, httpOptions: { apiVersion: body.apiVersion } });
      sessionRef.current = await ai.live.connect({
        model: body.model,
        config: {},
        callbacks: {
          onmessage: handleMessage,
          onerror: () => {
            setError("The connection dropped. Please try again.");
            setPhaseBoth("error");
            cleanup();
          },
          onclose: () => {
            if (phaseRef.current === "live" || phaseRef.current === "connecting") {
              setEndReason("closed");
              setPhaseBoth("ended");
            }
            cleanup();
          },
        },
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setError(
        name === "NotAllowedError"
          ? "Please allow microphone access in your browser settings, then try again."
          : name === "NotFoundError"
            ? "No microphone found on this device."
            : err instanceof Error
              ? err.message
              : "Something went wrong. Please try again.",
      );
      setPhaseBoth("error");
      cleanup();
    }
  };

  const end = (reason: EndReason = "user") => {
    if (phaseRef.current !== "live" && phaseRef.current !== "connecting") return;
    setEndReason(reason);
    setPhaseBoth("ended");
    cleanup();
  };

  const toggleMic = () => {
    const on = !micOnRef.current;
    micOnRef.current = on;
    setMicOn(on);
    lastActivity.current = Date.now();
    if (!on) {
      orbRef.current?.style.setProperty("--level", "0");
      if (gateOpen.current) sessionRef.current?.sendRealtimeInput({ audioStreamEnd: true });
      gateOpen.current = false;
      preRoll.current = [];
    }
  };

  const onOrbTap = () => {
    if (activityRef.current === "speaking") {
      interruptBot();
      setActivityBoth("listening");
    } else {
      toggleMic();
    }
  };

  const sendText = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    const session = sessionRef.current;
    if (!text || !session || phaseRef.current !== "live") return;
    interruptBot();
    appendText("user", text);
    userTurnId.current = null;
    lastActivity.current = Date.now();
    session.sendRealtimeInput({ text });
    setDraft("");
    setActivityBoth("thinking");
  };

  // ---------- screens ----------
  if (phase === "start" || phase === "ended" || phase === "error") {
    return (
      <main className="hero-bg min-h-dvh text-white">
        <div className="safe-bottom mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-5">
          <TopBar ui={ui} />

          <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
            <div className="relative h-32 w-32">
              <span className="orb-ring" />
              <span className="orb-ring" />
              <span className="orb-ring" />
              <div className="orb orb-idle h-full w-full" />
            </div>
            <p className="mt-10 font-heading text-sm font-semibold uppercase tracking-[0.2em] text-orange">
              {phase === "ended" ? "Thanks for chatting" : "Namaste!"}
            </p>
            <h1 className="mt-1 font-heading text-[28px] font-bold leading-tight">{ui.headline}</h1>
            <p className="mt-2 max-w-sm text-base text-white/75">{ui.tagline}</p>
            <p className="mt-3 text-sm text-white/55">Speak in Hindi, English, Hinglish or your own language</p>
          </div>

          {error && (
            <p role="alert" className="mb-3 rounded-2xl bg-orange/20 px-4 py-3 text-center text-sm">
              {error}
            </p>
          )}
          {phase === "ended" && END_NOTES[endReason] && (
            <p className="mb-3 rounded-2xl bg-white/10 px-4 py-3 text-center text-sm text-white/85">
              {END_NOTES[endReason]} Tap below to start a new one.
            </p>
          )}

          <button
            onClick={() => start()}
            className="flex w-full items-center justify-center gap-3 rounded-2xl bg-orange py-4 font-heading text-xl font-bold text-white shadow-[0_10px_30px_rgba(232,135,90,0.45)] transition active:scale-[0.97]"
          >
            <MicIcon className="h-6 w-6" />
            {phase === "start" ? "Start talking" : "Talk again"}
          </button>

          <p className="mt-5 mb-2 text-center text-sm text-white/60">Or tap a question to begin</p>
          <div className="grid grid-cols-2 gap-2">
            {ui.suggestions.map((q) => (
              <button
                key={q}
                onClick={() => start(q)}
                className="min-h-14 rounded-2xl bg-white/10 px-3 py-2.5 text-left text-sm leading-snug ring-1 ring-white/15 transition active:scale-[0.97] active:bg-white/20"
              >
                {q}
              </button>
            ))}
          </div>

          <p className="mt-5 text-center text-xs text-white/50">
            I&apos;m Zopper&apos;s AI assistant. This conversation may be recorded.
          </p>
          <Helpline dark />
        </div>
      </main>
    );
  }

  const connecting = phase === "connecting";
  const status = connecting
    ? { title: "Connecting…", hint: "Getting your assistant ready" }
    : activity === "speaking"
      ? { title: "Speaking…", hint: "Tap the orb to interrupt" }
      : activity === "thinking"
        ? { title: "Thinking…", hint: "One moment" }
        : micOn
          ? { title: "Listening…", hint: "Just speak. I'll reply when you pause." }
          : { title: "Mic is off", hint: "Type below, or tap the orb to talk" };

  const orbClass = connecting
    ? "orb-thinking"
    : activity === "speaking"
      ? "orb-speaking"
      : activity === "thinking"
        ? "orb-thinking"
        : micOn
          ? "orb-listening"
          : "orb-muted";

  return (
    <main className="flex h-dvh flex-col bg-offwhite">
      <div className="hero-bg rounded-b-[28px] px-5 pt-4 pb-5 text-white shadow-lg">
        <div className="mx-auto max-w-md">
          <TopBar ui={ui} onEnd={() => end("user")} />
          <div className="mt-4 flex items-center gap-5">
            <div className="relative h-20 w-20 shrink-0">
              {activity === "listening" && micOn && !connecting && (
                <>
                  <span className="orb-ring" />
                  <span className="orb-ring" />
                </>
              )}
              <button
                ref={orbRef}
                onClick={onOrbTap}
                disabled={connecting}
                aria-label={activity === "speaking" ? "Interrupt" : micOn ? "Turn mic off" : "Turn mic on"}
                className={`orb ${orbClass} flex h-full w-full items-center justify-center`}
              >
                {!micOn && activity === "listening" && <MicOffIcon className="h-8 w-8 text-white" />}
              </button>
            </div>
            <div className="min-w-0" aria-live="polite">
              <div className="flex items-center gap-2">
                <p className="font-heading text-2xl font-semibold">{status.title}</p>
                {(connecting || activity === "thinking") && <Dots />}
                {!connecting && activity === "speaking" && <Bars />}
              </div>
              <p className="text-sm text-white/70">{status.hint}</p>
            </div>
          </div>
        </div>
      </div>

      {endingSoon && (
        <p role="status" className="fade-up mx-auto mt-3 w-fit rounded-full bg-orange/15 px-4 py-2 text-center text-sm font-semibold text-navy">
          This chat will end in about a minute
        </p>
      )}

      <div ref={listRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-md space-y-3 px-4 py-4">
          {turns.map((t) =>
            t.role === "user" ? (
              <div key={t.id} className="fade-up flex justify-end">
                <p className="max-w-[85%] rounded-3xl rounded-br-md bg-royal px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-sm">
                  {t.text}
                </p>
              </div>
            ) : (
              <div key={t.id} className="fade-up flex items-end gap-2">
                <span className="orb mb-1 h-7 w-7 shrink-0" aria-hidden />
                <p className="max-w-[80%] rounded-3xl rounded-bl-md bg-white px-4 py-2.5 text-[15px] leading-relaxed shadow-sm ring-1 ring-navy/5">
                  {t.text}
                </p>
              </div>
            ),
          )}
          {!connecting && activity === "thinking" && (
            <div className="fade-up flex items-end gap-2">
              <span className="orb mb-1 h-7 w-7 shrink-0" aria-hidden />
              <div className="rounded-3xl rounded-bl-md bg-white px-4 py-3.5 shadow-sm ring-1 ring-navy/5">
                <Dots dark />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="safe-bottom border-t border-navy/10 bg-white px-3 pt-3">
        <form onSubmit={sendText} className="mx-auto flex max-w-md items-center gap-2">
          <button
            type="button"
            onClick={toggleMic}
            disabled={connecting}
            aria-pressed={micOn}
            aria-label={micOn ? "Turn mic off" : "Turn mic on"}
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition active:scale-95 disabled:opacity-40 ${
              micOn ? "bg-royal text-white" : "bg-navy/10 text-navy"
            }`}
          >
            {micOn ? <MicIcon className="h-5 w-5" /> : <MicOffIcon className="h-5 w-5" />}
          </button>
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              lastActivity.current = Date.now(); // typing counts as activity (no idle timeout)
            }}
            disabled={connecting}
            placeholder="Type your question…"
            enterKeyHint="send"
            maxLength={500}
            className="h-12 min-w-0 flex-1 rounded-full bg-offwhite px-4 text-base outline-none ring-1 ring-navy/10 placeholder:text-navy/40 focus:ring-2 focus:ring-royal"
          />
          <button
            type="submit"
            disabled={connecting || !draft.trim()}
            aria-label="Send"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-orange text-white transition active:scale-95 disabled:opacity-40"
          >
            <SendIcon className="h-5 w-5" />
          </button>
        </form>
        <div className="mx-auto max-w-md">
          <Helpline />
        </div>
      </div>
    </main>
  );
}

// ---------- small pieces ----------

function TopBar({ ui, onEnd }: { ui: BotUi; onEnd?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/zopper-logo.png"
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 shrink-0 rounded-md bg-white p-0.5"
          />
          <span className="font-heading text-[26px] leading-none font-bold tracking-tight">
            zopper<span className="text-orange">.</span>
          </span>
        </span>
        <span className="truncate rounded-full bg-white/12 px-2.5 py-1 text-xs font-medium text-white/85 ring-1 ring-white/15">
          {onEnd ? ui.name : ui.badge}
        </span>
      </div>
      {onEnd && (
        <button
          onClick={onEnd}
          className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-4 text-sm font-semibold ring-1 ring-white/20 active:bg-white/25"
        >
          <CloseIcon className="h-4 w-4" />
          End chat
        </button>
      )}
    </div>
  );
}

function Helpline({ dark }: { dark?: boolean }) {
  return (
    <a
      href={HELPLINE_TEL}
      className={`my-2 flex min-h-12 items-center justify-center gap-2 rounded-2xl text-sm font-semibold transition active:scale-[0.98] ${
        dark ? "text-white ring-1 ring-white/25" : "bg-navy/5 text-navy"
      }`}
    >
      <PhoneIcon className="h-4 w-4 text-orange" />
      Talk to a human: {HELPLINE_DISPLAY}
    </a>
  );
}

function Dots({ dark }: { dark?: boolean }) {
  const c = dark ? "bg-navy/60" : "bg-white";
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      <span className={`dot h-1.5 w-1.5 rounded-full ${c}`} />
      <span className={`dot h-1.5 w-1.5 rounded-full ${c}`} />
      <span className={`dot h-1.5 w-1.5 rounded-full ${c}`} />
    </span>
  );
}

function Bars() {
  return (
    <span className="inline-flex h-5 items-end gap-[3px]" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="bar h-full w-[3px] rounded-full bg-orange" />
      ))}
    </span>
  );
}

type IconProps = { className?: string };
const svg = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function MicIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...svg} aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
    </svg>
  );
}
function MicOffIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...svg} aria-hidden>
      <path d="M2 2l20 20M9 9v1a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.8M19 10a7 7 0 0 1-.7 3M5 10a7 7 0 0 0 11.6 5.3M12 17v5M8 22h8" />
    </svg>
  );
}
function SendIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...svg} aria-hidden>
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}
function PhoneIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...svg} aria-hidden>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
    </svg>
  );
}
function CloseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...svg} aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
