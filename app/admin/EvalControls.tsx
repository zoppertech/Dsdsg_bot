"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const PARALLEL = 3; // questions evaluated at the same time

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/admin/api/eval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json as T;
}

/** Run `work` over `items`, a few at a time. */
async function pool<T>(items: T[], work: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
}

/** Warn before closing the tab while a run is in progress. */
function useLeaveWarning(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
}

const btn =
  "rounded-full bg-royal px-4 py-2 text-sm font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50";

export function RunGoldenButton({ counts }: { counts: { all: number; customer: number; promoter: number } }) {
  const router = useRouter();
  const [bot, setBot] = useState<"all" | "customer" | "promoter">("all");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0, errors: 0 });
  const [error, setError] = useState("");
  useLeaveWarning(running);

  const run = async () => {
    setError("");
    setRunning(true);
    try {
      const { runId, itemIds } = await call<{ runId: string; itemIds: string[] }>({ action: "start", bot });
      setProgress({ done: 0, total: itemIds.length, failed: 0, errors: 0 });
      await pool(itemIds, async (itemId) => {
        let r: { pass: boolean; error: string | null } = { pass: false, error: "request failed" };
        try {
          r = await call({ action: "item", runId, itemId });
        } catch {}
        setProgress((p) => ({ ...p, done: p.done + 1, failed: p.failed + (r.pass ? 0 : 1), errors: p.errors + (r.error ? 1 : 0) }));
      });
      await call({ action: "finish", runId });
      router.push(`/admin/quality?run=${runId}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setRunning(false);
    }
  };

  const minutes = Math.max(1, Math.round((counts[bot] * 25) / PARALLEL / 60));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={bot}
          onChange={(e) => setBot(e.target.value as typeof bot)}
          disabled={running}
          className="h-9 rounded-full bg-offwhite px-3 text-sm ring-1 ring-navy/15"
        >
          <option value="all">Both bots ({counts.all} questions)</option>
          <option value="customer">Customer ({counts.customer})</option>
          <option value="promoter">Promoter ({counts.promoter})</option>
        </select>
        <button onClick={run} disabled={running} className={btn}>
          {running ? "Running…" : "Run golden test"}
        </button>
        {!running && <span className="text-xs text-navy/50">Takes about {minutes} min. Keep this tab open.</span>}
      </div>
      {running && progress.total > 0 && (
        <div>
          <div className="h-2 overflow-hidden rounded-full bg-navy/10">
            <div className="h-full bg-royal transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
          <p className="mt-1 text-xs text-navy/60">
            {progress.done}/{progress.total} done · {progress.failed} not passed{progress.errors ? ` · ${progress.errors} errors` : ""}
          </p>
        </div>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

export function ScoreChatsButton({ bot, unscored }: { bot: string; unscored: number }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState("");
  useLeaveWarning(running);

  const run = async () => {
    setRunning(true);
    setMsg("");
    try {
      const { ids } = await call<{ ids: string[] }>({ action: "unscored", bot, limit: 20 });
      let done = 0;
      let failed = 0;
      setMsg(`0/${ids.length}`);
      await pool(ids, async (id) => {
        try {
          await call({ action: "score", id });
        } catch {
          failed++;
        }
        done++;
        setMsg(`${done}/${ids.length}${failed ? ` · ${failed} failed` : ""}`);
      });
      setMsg(ids.length ? `Scored ${ids.length - failed} chats${failed ? `, ${failed} failed (see Logs)` : ""}.` : "Nothing to score.");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={run} disabled={running || unscored === 0} className={btn}>
        {running ? "Scoring…" : `Score latest ${Math.min(20, unscored)} unscored chats`}
      </button>
      {msg && <span className="text-xs text-navy/60">{msg}</span>}
    </div>
  );
}

export function ScoreOneButton({ id, again }: { id: string; again?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <span className="inline-flex items-center gap-2">
      <button
        disabled={busy}
        className={btn}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await call({ action: "score", id });
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Scoring…" : again ? "Score again" : "Score this chat"}
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}

export function FinishRunButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      className={btn}
      onClick={async () => {
        setBusy(true);
        try {
          await call({ action: "finish", runId });
        } finally {
          setBusy(false);
          router.refresh();
        }
      }}
    >
      {busy ? "Saving…" : "Close this run with the results so far"}
    </button>
  );
}

/** Re-run only some golden questions (e.g. the ones that did not pass), as a new run. */
export function RerunButton({ itemIds, label }: { itemIds: string[]; label: string }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState("");
  useLeaveWarning(running);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        disabled={running || itemIds.length === 0}
        className={btn}
        onClick={async () => {
          setRunning(true);
          setMsg("");
          try {
            const { runId } = await call<{ runId: string }>({ action: "start", bot: "all", itemIds });
            let done = 0;
            await pool(itemIds, async (itemId) => {
              try {
                await call({ action: "item", runId, itemId });
              } catch {}
              setMsg(`${++done}/${itemIds.length}`);
            });
            await call({ action: "finish", runId });
            router.push(`/admin/quality?run=${runId}`);
            router.refresh();
          } catch (e) {
            setMsg(e instanceof Error ? e.message : "Something went wrong");
          } finally {
            setRunning(false);
          }
        }}
      >
        {running ? "Running…" : label}
      </button>
      {msg && <span className="text-xs text-navy/60">{msg}</span>}
    </span>
  );
}
