import Link from "next/link";
import type { Filter as MongoFilter } from "mongodb";
import { isAdmin } from "@/lib/adminAuth";
import { conversations, events, type EventDoc } from "@/lib/mongodb";
import Login from "../Login";
import { BotBadge, Card, formatClock, lastDays, Stat, Tag, TZ } from "../ui";

export const dynamic = "force-dynamic";

const DAYS = 14;
type Search = { level?: string; type?: string; bot?: string; session?: string };

// Every event type the app records, with a plain-English meaning (shown as a hint).
const EVENT_TYPES: Record<string, string> = {
  token_issued: "A chat was started (server gave a Gemini token)",
  token_rate_limited: "Too many chats started from one device in a minute",
  token_forbidden: "Promoter bot opened with a wrong secret link",
  token_error: "Server could not create a Gemini token",
  session_connected: "Browser connected to Gemini (connectMs = wait time)",
  connect_failed: "Chat could not start (mic denied / no mic / other)",
  connection_dropped: "Gemini connection dropped during a chat",
  session_ended: "Chat ended (reason: user / time / idle / hidden / closed / error)",
  log_saved: "Conversation saved to the database",
  log_rejected: "A save request was rejected (bad ticket)",
  log_error: "Conversation could not be saved",
  eval_run_started: "Golden test run started",
  eval_run_finished: "Golden test run finished",
  eval_error: "Error while evaluating (bot or judge)",
};

export default async function LogsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  if (!(await isAdmin())) return <Login />;
  try {
    return await Logs(sp);
  } catch (err) {
    console.error("[admin/logs] failed:", err instanceof Error ? err.message : "unknown error");
    return <p className="rounded-2xl bg-orange/15 p-4 text-sm">Couldn&apos;t load logs from the database. Check the server logs.</p>;
  }
}

type DayRow = { _id: { day: string; type: string; level: string }; count: number; connectMs: number | null };

async function Logs(sp: Search) {
  const col = await events();
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const filter: MongoFilter<EventDoc> = {};
  if (sp.level === "error" || sp.level === "warn") filter.level = sp.level === "warn" ? { $in: ["warn", "error"] } : "error";
  if (sp.type && sp.type in EVENT_TYPES) filter.type = sp.type;
  if (sp.bot === "customer" || sp.bot === "promoter") filter.bot = sp.bot;
  if (sp.session && /^[0-9a-f-]{36}$/i.test(sp.session)) filter.sessionId = sp.session;

  const [daily, problems, list, sessionChat] = await Promise.all([
    col
      .aggregate<DayRow>([
        { $match: { time: { $gte: since } } },
        {
          $group: {
            _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$time", timezone: TZ } }, type: "$type", level: "$level" },
            count: { $sum: 1 },
            connectMs: { $avg: "$data.connectMs" },
          },
        },
      ])
      .toArray(),
    col
      .aggregate<{ _id: { type: string; level: string }; count: number; last: Date }>([
        { $match: { time: { $gte: weekAgo }, level: { $in: ["warn", "error"] } } },
        { $group: { _id: { type: "$type", level: "$level" }, count: { $sum: 1 }, last: { $max: "$time" } } },
        { $sort: { count: -1 } },
      ])
      .toArray(),
    col.find(filter).sort({ time: -1 }).limit(200).toArray(),
    filter.sessionId ? (await conversations()).findOne({ sessionId: sp.session }, { projection: { _id: 1 } }) : null,
  ]);

  // Build the per-day usage table.
  const days = lastDays(DAYS).reverse();
  const usage = days.map((day) => {
    const rows = daily.filter((r) => r._id.day === day);
    const count = (type: string) => rows.filter((r) => r._id.type === type).reduce((s, r) => s + r.count, 0);
    const connected = rows.find((r) => r._id.type === "session_connected");
    return {
      day,
      started: count("token_issued"),
      connected: count("session_connected"),
      saved: count("log_saved"),
      failedStart: count("connect_failed"),
      dropped: count("connection_dropped"),
      errors: rows.filter((r) => r._id.level === "error").reduce((s, r) => s + r.count, 0),
      connectMs: connected?.connectMs ?? null,
    };
  });
  const today = usage[0];
  const week = usage.slice(0, 7);
  const sum = (k: keyof (typeof usage)[number]) => week.reduce((s, d) => s + (Number(d[k]) || 0), 0);
  const weekConnect = week.filter((d) => d.connectMs !== null);
  const avgConnect = weekConnect.length ? weekConnect.reduce((s, d) => s + (d.connectMs ?? 0), 0) / weekConnect.length : null;

  const qs = (patch: Partial<Search>) => {
    const p = new URLSearchParams();
    const merged = { ...sp, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/admin/logs?${s}` : "/admin/logs";
  };

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Chats started today" value={String(today.started)} hint={`${today.saved} saved`} />
        <Stat label="Errors today" value={String(today.errors)} hint={`${sum("errors")} in the last 7 days`} />
        <Stat
          label="Start success (7 days)"
          value={sum("started") ? `${Math.round((sum("connected") / sum("started")) * 100)}%` : "–"}
          hint={`${sum("connected")} of ${sum("started")} connected`}
        />
        <Stat label="Avg connect time (7 days)" value={avgConnect !== null ? `${(avgConnect / 1000).toFixed(1)}s` : "–"} />
      </section>

      <Card title="Problems in the last 7 days">
        {problems.length ? (
          <ul className="divide-y divide-navy/10 text-sm">
            {problems.map((p) => (
              <li key={`${p._id.type}-${p._id.level}`} className="flex flex-wrap items-center gap-3 py-2">
                <Tag tone={p._id.level === "error" ? "red" : "orange"}>{p._id.level}</Tag>
                <Link href={qs({ type: p._id.type, session: undefined })} className="font-mono text-xs text-royal">
                  {p._id.type}
                </Link>
                <span className="text-navy/60">{EVENT_TYPES[p._id.type] ?? ""}</span>
                <span className="ml-auto font-semibold">{p.count}×</span>
                <span className="text-xs text-navy/50">last {formatClock(p.last)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-emerald-700">No errors or warnings in the last 7 days.</p>
        )}
      </Card>

      <Card title={`Usage per day (last ${DAYS} days)`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-navy/60">
              <tr>
                <th className="py-2 pr-3 font-medium">Day</th>
                <th className="py-2 pr-3 font-medium">Started</th>
                <th className="py-2 pr-3 font-medium">Connected</th>
                <th className="py-2 pr-3 font-medium">Saved chats</th>
                <th className="py-2 pr-3 font-medium">Couldn&apos;t start</th>
                <th className="py-2 pr-3 font-medium">Dropped</th>
                <th className="py-2 pr-3 font-medium">Errors</th>
                <th className="py-2 font-medium">Avg connect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy/10">
              {usage.map((d) => (
                <tr key={d.day} className={d.started === 0 && d.errors === 0 ? "text-navy/40" : ""}>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{d.day}</td>
                  <td className="py-1.5 pr-3">{d.started}</td>
                  <td className="py-1.5 pr-3">{d.connected}</td>
                  <td className="py-1.5 pr-3">{d.saved}</td>
                  <td className="py-1.5 pr-3">{d.failedStart || ""}</td>
                  <td className="py-1.5 pr-3">{d.dropped || ""}</td>
                  <td className={`py-1.5 pr-3 ${d.errors ? "font-semibold text-red-700" : ""}`}>{d.errors || ""}</td>
                  <td className="py-1.5">{d.connectMs !== null ? `${(d.connectMs / 1000).toFixed(1)}s` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title={filter.sessionId ? "One session" : "Event log (latest 200)"}
        right={
          sessionChat ? (
            <Link href={`/admin?id=${sessionChat._id}`} className="text-sm text-royal">
              Open this conversation →
            </Link>
          ) : undefined
        }
      >
        <form method="get" action="/admin/logs" className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <select name="level" defaultValue={sp.level ?? ""} className="h-9 rounded-full bg-offwhite px-3 ring-1 ring-navy/15">
            <option value="">All levels</option>
            <option value="warn">Warnings + errors</option>
            <option value="error">Errors only</option>
          </select>
          <select name="type" defaultValue={sp.type ?? ""} className="h-9 rounded-full bg-offwhite px-3 ring-1 ring-navy/15">
            <option value="">All events</option>
            {Object.keys(EVENT_TYPES).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select name="bot" defaultValue={sp.bot ?? ""} className="h-9 rounded-full bg-offwhite px-3 ring-1 ring-navy/15">
            <option value="">Both bots</option>
            <option value="customer">Customer</option>
            <option value="promoter">Promoter</option>
          </select>
          {sp.session && <input type="hidden" name="session" value={sp.session} />}
          <button className="h-9 rounded-full bg-royal px-4 font-semibold text-white">Filter</button>
          {(sp.level || sp.type || sp.bot || sp.session) && (
            <Link href="/admin/logs" className="text-royal">
              Clear
            </Link>
          )}
        </form>
        {list.length ? (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-xs">
              <tbody className="divide-y divide-navy/5">
                {list.map((e) => (
                  <tr key={String(e._id)} className={e.level === "error" ? "bg-red-50" : e.level === "warn" ? "bg-amber-50" : ""}>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-navy/50">{formatClock(e.time)}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap" title={EVENT_TYPES[e.type]}>
                      <span className={e.level === "error" ? "text-red-700" : e.level === "warn" ? "text-amber-700" : ""}>{e.type}</span>
                    </td>
                    <td className="py-1.5 pr-3">{e.bot && <BotBadge bot={e.bot} />}</td>
                    <td className="py-1.5 pr-3 break-all text-navy/70">{e.data ? JSON.stringify(e.data) : ""}</td>
                    <td className="py-1.5 whitespace-nowrap">
                      {e.sessionId && !filter.sessionId && (
                        <Link href={qs({ session: e.sessionId, type: undefined, level: undefined })} className="text-royal">
                          session
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-navy/60">No events match.</p>
        )}
        <p className="mt-3 text-xs text-navy/50">
          Hover an event name to see what it means. Events are also written to the server log as JSON lines starting with “[event]”.
          No IP addresses, locations or conversation text are stored here.
        </p>
      </Card>
    </div>
  );
}
