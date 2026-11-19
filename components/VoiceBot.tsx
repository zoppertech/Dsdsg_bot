"use client";

import type { LiveServerMessage, Session } from "@google/genai";
import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { preconnect } from "react-dom";
import { PcmPlayer, int16ToBase64 } from "@/lib/audioPlayer";
import { HELPLINE_DISPLAY, HELPLINE_TEL, type BotUi } from "@/lib/botUi";

type Phase = "start" | "connecting" | "live" | "ended" | "error";
type Activity = "listening" | "thinking" | "speaking";
type Turn = { id: number; role: "user" | "bot"; text: string };
type EndReason = "user" | "time" | "idle" | "hidden" | "closed";
type Limits = { enabled: boolean; maxMinutes: number; idleSeconds: number };
type TokenResponse = { token: string; model: string; apiVersion: string; limits?: Limits; logTicket?: string };
/** Why a session ended, as recorded in the logs ("error" = the connection failed). */
type LoggedEndReason = EndReason | "error";
/** The conversation being recorded for /api/log (text only, never audio). */
type LogState = { ticket: string; sessionId: string; startTime: number; connectMs: number; turns: Turn[] };

const LOG_MAX_BYTES = 60_000; // sendBeacon only accepts ~64 KB
const LOG_MAX_TEXT = 1_500;

/** POST that still gets delivered if the page is closing. */
function beacon(url: string, body: string) {
  try {
    if (navigator.sendBeacon?.(url, new Blob([body], { type: "text/plain" }))) return;
  } catch {}
  fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
}

/** Save a finished conversation. */
function sendConversationLog(log: LogState, endReason: LoggedEndReason) {
  const turns = log.turns
    .filter((t) => t.text.trim())
    .map((t) => ({ role: t.role, text: t.text.trim().slice(0, LOG_MAX_TEXT) }));
  if (!turns.some((t) => t.role === "user")) return; // nothing was asked: nothing to save
  const meta = { ticket: log.ticket, sessionId: log.sessionId, startTime: log.startTime, endTime: Date.now(), endReason, connectMs: log.connectMs };
  const build = (n: number) => JSON.stringify({ ...meta, turns: turns.slice(0, n) });
  let n = turns.length;
  let body = build(n);
  while (body.length > LOG_MAX_BYTES && n > 1) body = build(--n); // very long chat: keep the start
  beacon("/api/log", body);
}

function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

/** Thrown inside start() when the user ended the chat before it finished connecting. */
const ABORTED = Symbol("aborted");

// ---------- cost controls ----------
// Gemini re-bills the whole conversation (prompt + all audio so far) on every turn,
// so every second of audio we DON'T send saves money on every later turn too.
// Time limit + idle timeout come from the server (.env.local) and are OFF unless SESSION_LIMITS_ENABLED=true.
const NO_LIMITS: Limits = { enabled: false, maxMinutes: 0, idleSeconds: 0 };
const WARN_BEFORE_MS = 60_000; // show "This chat will end soon" 1 minute before the limit
const HIDDEN_GRACE_MS = 3_000; // always on: end if the user leaves the tab / locks the phone (no billing in the background)
const GATE_MIN_LEVEL = 0.015; // mic level that counts as speech (0..1)
const GATE_HANGOVER_MS = 1_500; // keep sending this long after speech so Gemini notices the pause
const PREROLL_CHUNKS = 3; // also send the 300 ms before speech was detected (first word isn't cut)
const NOISE_MAX_MS = 10_000; // mic open this long with no words recognised = background noise: stop sending
const THINKING_MAX_MS = 10_000; // "Thinking…" with no reply this long: go back to "Listening…"

const END_NOTES: Record<EndReason, string> = {
  user: "Thanks for chatting!",
  time: "This chat reached its time limit. Thanks for chatting!",
  idle: "This chat ended because it was quiet for a while.",
  hidden: "This chat ended because you left the page.",
  closed: "The connection was closed.",
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
  const limitsRef = useRef<Limits>(NO_LIMITS);
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
  const runRef = useRef(0); // bumped on every start/cleanup, so stale async work can tell it's outdated
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
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gateOpenedAt = useRef(0);
  const nextId = useRef(1);
  const userTurnId = useRef<number | null>(null);
  const botTurnId = useRef<number | null>(null);
  const orbRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const logTicket = useRef<string | null>(null);
  const logRef = useRef<LogState | null>(null);
  // Logging: one random id per session links the browser events, server events and saved chat.
  const sessionId = useRef("");
  const connectStartedAt = useRef(0);
  const liveStartedAt = useRef(0);
  const endReasonRef = useRef<LoggedEndReason>("user");

  /** Report a session event to /api/event (no personal data). */
  const track = (type: string, data: Record<string, string | number | undefined> = {}) => {
    if (!sessionId.current) return;
    beacon("/api/event", JSON.stringify({ type, bot: ui.bot, sessionId: sessionId.current, data }));
  };

  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };
  const setActivityBoth = (a: Activity) => {
    activityRef.current = a;
    setActivity(a);
    // Safety net: if Gemini never replies (e.g. it only heard noise), don't stay on "Thinking…".
    if (stuckTimer.current) clearTimeout(stuckTimer.current);
    stuckTimer.current = null;
    if (a === "thinking") {
      stuckTimer.current = setTimeout(() => {
        if (activityRef.current === "thinking" && !botTurnActive.current && phaseRef.current === "live") {
          finishBotTurn();
        }
      }, THINKING_MAX_MS);
    }
  };

  // ---------- transcript ----------
  const appendText = (role: Turn["role"], text: string, { log = true } = {}) => {
    if (!text) return;
    const idRef = role === "user" ? userTurnId : botTurnId;
    const id = idRef.current;
    // Mirror the transcript into a ref, so it can be saved synchronously when the page closes.
    const logged = log ? logRef.current : null;
    if (id === null) {
      const newId = nextId.current++;
      idRef.current = newId;
      const turn = { id: newId, role, text: text.trimStart() };
      setTurns((prev) => [...prev, turn]);
      logged?.turns.push({ ...turn });
    } else {
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, text: t.text + text } : t)));
      const t = logged?.turns.find((x) => x.id === id);
      if (t) t.text += text;
    }
  };

  /** Send the current conversation to /api/log (once). */
  const flushLog = () => {
    if (liveStartedAt.current) {
      track("session_ended", { reason: endReasonRef.current, seconds: Math.round((Date.now() - liveStartedAt.current) / 1000) });
      liveStartedAt.current = 0;
    }
    const log = logRef.current;
    logRef.current = null;
    if (log) sendConversationLog(log, endReasonRef.current);
  };

  // Follow new text only while the user is at the bottom (don't yank them back if they
  // scrolled up to re-read). Instant jump while text streams in, so it doesn't stutter.
  const stickToBottom = useRef(true);
  const onListScroll = () => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [turns, activity]);

  // Warm up while the user is still reading the start screen, so tapping Start connects faster:
  // open the connection to Google early and download the Gemini SDK in the background.
  useEffect(() => {
    preconnect("https://generativelanguage.googleapis.com");
    const load = () => import("@google/genai").catch(() => {});
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(load);
    else setTimeout(load, 1500);
  }, []);

  // ---------- session lifecycle ----------
  const cleanup = () => {
    flushLog(); // every way a chat can end (button, timeout, tab closed, error) passes through here
    runRef.current++;
    if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
    if (stuckTimer.current) clearTimeout(stuckTimer.current);
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
    const isActive = () => phaseRef.current === "live" || phaseRef.current === "connecting";

    // Browsers pause audio while the page is in the background. When the user comes back,
    // restart it; otherwise the bot's reply never "finishes" and the mic stays blocked.
    const resumeAudio = () => {
      if (!isActive() || document.hidden) return;
      const track = streamRef.current?.getAudioTracks()[0];
      if (track?.readyState === "ended") return end("hidden"); // the OS took the mic away
      const ctx = ctxRef.current;
      if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
    };

    const onVisibility = () => {
      if (hiddenTimer.current) clearTimeout(hiddenTimer.current);
      hiddenTimer.current = null;
      if (!isActive()) return;
      if (document.hidden) hiddenTimer.current = setTimeout(() => end("hidden"), HIDDEN_GRACE_MS);
      else resumeAudio();
    };

    // Browser back/forward or closing the tab: end now. Otherwise the page can come back
    // from the back-forward cache looking "live" with a dead connection.
    const onPageHide = () => end("hidden");

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("focus", resumeAudio);
    // Some phones only allow restarting audio after a tap.
    document.addEventListener("pointerdown", resumeAudio);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("focus", resumeAudio);
      document.removeEventListener("pointerdown", resumeAudio);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Runs every second during a session: time limit, "ending soon" warning, idle timeout. Does nothing if limits are off. */
  const startTicking = () => {
    const now = Date.now();
    lastActivity.current = now;
    if (tickTimer.current) clearInterval(tickTimer.current);
    tickTimer.current = null;
    const limits = limitsRef.current;
    if (!limits.enabled) return;
    deadline.current = now + limits.maxMinutes * 60_000;
    const idleMs = limits.idleSeconds * 1000;
    tickTimer.current = setInterval(() => {
      if (phaseRef.current !== "live") return;
      const t = Date.now();
      const left = deadline.current - t;
      if (left <= 0) return end("time");
      if (left <= WARN_BEFORE_MS) setEndingSoon(true);
      // Idle = no recognised words / typing for a while. Mic noise alone doesn't keep the chat alive.
      const quiet = activityRef.current === "listening" && !botTurnActive.current;
      if (quiet && t - lastActivity.current > idleMs) end("idle");
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
      const now = Date.now();
      const connectMs = now - connectStartedAt.current;
      liveStartedAt.current = now;
      track("session_connected", { connectMs });
      if (logTicket.current) {
        logRef.current = { ticket: logTicket.current, sessionId: sessionId.current, startTime: now, connectMs, turns: [] };
      }
      const q = pendingQuestion.current;
      pendingQuestion.current = null;
      if (q) {
        appendText("user", q);
        userTurnId.current = null;
        sessionRef.current?.sendRealtimeInput({ text: q });
        setActivityBoth("thinking");
      } else {
        // Show the greeting instantly instead of waiting for Gemini to say it:
        // the user can start talking at once, and we don't pay for a greeting turn.
        appendText("bot", ui.greeting, { log: false }); // fixed text, not worth saving
        botTurnId.current = null;
        setActivityBoth("listening");
      }
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
      lastActivity.current = Date.now(); // real words heard
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

  /** Short-lived token from our server (the real API key never reaches the phone). */
  const fetchToken = async (): Promise<TokenResponse> => {
    const res = await fetch(`/api/token?bot=${ui.bot}&sid=${sessionId.current}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(secret ? { secret } : {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Couldn't connect. Please try again.");
    return body as TokenResponse;
  };

  const start = async (question?: string) => {
    setError("");
    setTurns([]);
    stickToBottom.current = true;
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
    sessionId.current = newSessionId();
    connectStartedAt.current = Date.now();
    liveStartedAt.current = 0;
    endReasonRef.current = "user";

    // Every cleanup() bumps runRef, so if the user ends the chat while we're still
    // connecting, the steps below notice and stop instead of opening a stray session.
    const run = ++runRef.current;
    const checkRun = () => {
      if (run !== runRef.current) throw ABORTED;
    };

    // Start the slow network steps right away, in parallel with mic setup.
    let tokenStartedAt = Date.now();
    let tokenPromise = fetchToken();
    tokenPromise.catch(() => {}); // handled when awaited below
    const sdkPromise = import("@google/genai");
    sdkPromise.catch(() => {});

    try {
      // 1) Audio must be created inside the tap, or mobile browsers keep it silent.
      const AC: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      ctxRef.current = ctx;
      ctx.resume().catch(() => {});
      // If the OS pauses audio while the page is visible (e.g. a phone call), try to restart it.
      ctx.onstatechange = () => {
        if (ctx.state === "closed" || ctx.state === "running" || document.hidden) return;
        if (phaseRef.current === "live") ctx.resume().catch(() => {});
      };

      // 2) Microphone + audio worklet, loaded in parallel.
      const workletReady = ctx.audioWorklet.addModule("/worklets/capture-worklet.js");
      workletReady.catch(() => {});
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      streamRef.current = stream; // store first so cleanup() can release it
      checkRun();
      await workletReady;
      checkRun();
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
            gateOpenedAt.current = now;
            lastLoud.current = now;
            preRoll.current.forEach(send);
            preRoll.current = [];
          }
        } else {
          send(e.data);
          const noWords = now - Math.max(gateOpenedAt.current, lastActivity.current) > NOISE_MAX_MS;
          if (noWords) {
            // Loud for 10 s but Gemini recognised no words: it's store noise (music, crowd).
            // Stop streaming it and raise the bar so the same noise doesn't reopen the mic.
            gateOpen.current = false;
            noiseFloor.current = Math.max(noiseFloor.current, level);
            session.sendRealtimeInput({ audioStreamEnd: true });
          } else if (loud) {
            lastLoud.current = now;
          } else if (now - lastLoud.current > GATE_HANGOVER_MS) {
            gateOpen.current = false;
            session.sendRealtimeInput({ audioStreamEnd: true }); // tells Gemini the mic paused
          }
        }
      };

      playerRef.current = new PcmPlayer(ctx, () => {
        if (turnDone.current) finishBotTurn();
      });

      // 3) Short-lived token (fetched in parallel above). A token must be used within
      // 1 minute, so if the user sat on the mic permission prompt, get a fresh one.
      if (Date.now() - tokenStartedAt > 45_000) {
        tokenStartedAt = Date.now();
        tokenPromise = fetchToken();
        tokenPromise.catch(() => {});
      }
      const body = await tokenPromise;
      checkRun();
      limitsRef.current = body.limits ?? NO_LIMITS;
      logTicket.current = body.logTicket ?? null;

      // 4) Connect to Gemini Live. All settings are locked inside the token.
      const { GoogleGenAI } = await sdkPromise;
      checkRun();
      const ai = new GoogleGenAI({ apiKey: body.token, httpOptions: { apiVersion: body.apiVersion } });
      // Callbacks from an old session (after "End chat" / "Talk again") are ignored.
      const current = () => run === runRef.current;
      sessionRef.current = await ai.live.connect({
        model: body.model,
        config: {},
        callbacks: {
          onmessage: (msg) => {
            if (current()) handleMessage(msg);
          },
          onerror: (e) => {
            if (!current()) return;
            track("connection_dropped", { phase: phaseRef.current, reason: e?.message });
            endReasonRef.current = "error";
            setError("The connection dropped. Please try again.");
            setPhaseBoth("error");
            cleanup();
          },
          onclose: (e) => {
            if (!current()) return;
            if (phaseRef.current === "live" || phaseRef.current === "connecting") {
              // Closed by Google, not by us (e.g. the ~15-minute session limit or a network drop).
              track("connection_dropped", { phase: phaseRef.current, code: e?.code, reason: e?.reason });
              endReasonRef.current = "closed";
              setEndReason("closed");
              setPhaseBoth("ended");
            }
            cleanup();
          },
        },
      });
      checkRun();
    } catch (err) {
      if (err === ABORTED) {
        cleanup(); // user ended the chat while connecting: release whatever was opened
        return;
      }
      const name = err instanceof DOMException ? err.name : "";
      track("connect_failed", {
        kind: name === "NotAllowedError" ? "mic_denied" : name === "NotFoundError" ? "mic_missing" : "other",
        message: err instanceof Error ? err.message : String(err),
      });
      endReasonRef.current = "error";
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
    endReasonRef.current = reason;
    setEndReason(reason);
    setPhaseBoth("ended");
    cleanup();
  };

  const toggleMic = () => {
    const on = !micOnRef.current;
    micOnRef.current = on;
    setMicOn(on);
    lastActivity.current = Date.now();
    // Actually mute the microphone (not just stop sending), so nothing is captured while it's off.
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = on));
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
              {END_NOTES[endReason]}
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
          This chat will end soon
        </p>
      )}

      <div ref={listRef} onScroll={onListScroll} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-md space-y-3 px-4 py-4">
          {turns.map((t) => (
            <Bubble key={t.id} role={t.role} text={t.text} />
          ))}
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

/** One chat bubble. Memoised so streaming text re-renders only the bubble that changed. */
const Bubble = memo(function Bubble({ role, text }: { role: Turn["role"]; text: string }) {
  return role === "user" ? (
    <div className="fade-up flex justify-end">
      <p className="max-w-[85%] rounded-3xl rounded-br-md bg-royal px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-sm">
        {text}
      </p>
    </div>
  ) : (
    <div className="fade-up flex items-end gap-2">
      <span className="orb mb-1 h-7 w-7 shrink-0" aria-hidden />
      <p className="max-w-[80%] rounded-3xl rounded-bl-md bg-white px-4 py-2.5 text-[15px] leading-relaxed shadow-sm ring-1 ring-navy/5">
        {text}
      </p>
    </div>
  );
});

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
