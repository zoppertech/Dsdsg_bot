import Link from "next/link";
import { ObjectId } from "mongodb";
import { isAdmin } from "@/lib/adminAuth";
import { conversations, events } from "@/lib/mongodb";
import { ScoreOneButton } from "./EvalControls";
import Login from "./Login";
import {
  BotBadge,
  BotFilter,
  Card,
  formatClock,
  formatDuration,
  formatTime,
  lastDays,
  parseFilter,
  Score,
  Stat,
  Tag,
  TZ,
  type Filter,
} from "./ui";

// Always render on the server, per request (the password check must run every time).
export const dynamic = "force-dynamic";

const DAYS = 30;
type Search = { bot?: string; id?: string; error?: string };

export default async function AdminPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  if (!(await isAdmin())) return <Login error={sp.error} />;

  const filter = parseFilter(sp.bot);
  let content: React.ReactNode;
  try {
    content = sp.id ? await Conversation({ id: sp.id, filter }) : await Dashboard({ filter });
  } catch (err) {
    console.error("[admin] failed:", err instanceof Error ? err.message : "unknown error");
    content = <p className="rounded-2xl bg-orange/15 p-4 text-sm">Couldn&apos;t load data from the database. Check the Logs tab or server logs.</p>;
  }

  return (
    <>
      <BotFilter filter={filter} base="/admin" />
      {content}
    </>
  );
}

// ---------- dashboard ----------
type Stats = {
  totals: { count: number; avgDuration: number; flagged: number }[];
  perDay: { _id: string; count: number }[];
  confirm: { _id: string; count: number; example: string; bots: string[] }[];
  languages: { _id: string; count: number }[];
  quality: { count: number; accuracy: number; completeness: number; relevance: number }[];
};

async function Dashboard({ filter }: { filter: Filter }) {
  const col = await conversations();
  const match = filter === "all" ? {} : { bot: filter };
  const since = new Date(Date.now() - DAYS * 86_400_000);

  const [statsResult, recent] = await Promise.all([
    col
      .aggregate<Stats>([
        { $match: match },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  count: { $sum: 1 },
                  avgDuration: { $avg: "$durationSeconds" },
                  flagged: { $sum: { $cond: ["$saidWillConfirm", 1, 0] } },
                },
              },
            ],
            perDay: [
              { $match: { startTime: { $gte: since } } },
              {
                $group: {
                  _id: { $dateToString: { format: "%Y-%m-%d", date: "$startTime", timezone: TZ } },
                  count: { $sum: 1 },
                },
              },
            ],
            confirm: [
              { $unwind: "$confirmQuestions" },
              {
                $group: {
                  _id: "$confirmQuestions.key",
                  count: { $sum: 1 },
                  example: { $first: "$confirmQuestions.text" },
                  bots: { $addToSet: "$bot" },
                },
              },
              { $sort: { count: -1, _id: 1 } },
              { $limit: 15 },
            ],
            languages: [{ $group: { _id: "$language", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
            quality: [
              { $match: { eval: { $exists: true } } },
              {
                $group: {
                  _id: null,
                  count: { $sum: 1 },
                  accuracy: { $avg: "$eval.accuracy" },
                  completeness: { $avg: "$eval.completeness" },
                  relevance: { $avg: "$eval.relevance" },
                },
              },
            ],
          },
        },
      ])
      .toArray(),
    col
      .find(match, { projection: { turns: 0, confirmQuestions: 0, "eval.issues": 0 } })
      .sort({ startTime: -1 })
      .limit(50)
      .toArray(),
  ]);

  const stats = statsResult[0];
  const totals = stats?.totals[0] ?? { count: 0, avgDuration: 0, flagged: 0 };
  const q = stats?.quality[0];
  const byDay = new Map(stats?.perDay.map((d) => [d._id, d.count]));
  const days = lastDays(DAYS).map((key) => ({ key, count: byDay.get(key) ?? 0 }));
  const maxDay = Math.max(1, ...days.map((d) => d.count));
  const qs = filter === "all" ? "" : `bot=${filter}&`;

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total conversations" value={totals.count.toLocaleString("en-IN")} />
        <Stat label="Average duration" value={formatDuration(totals.avgDuration)} />
        <Stat label='Said "will confirm"' value={totals.flagged.toLocaleString("en-IN")} />
        <Stat
          label="Answer quality (scored chats)"
          value={q ? (((q.accuracy + q.completeness + q.relevance) / 3).toFixed(1) + " / 5") : "–"}
          hint={q ? `${q.count} chats scored · see Quality tab` : "Score chats in the Quality tab"}
        />
      </section>

      <Card title={`Conversations per day (last ${DAYS} days)`}>
        <div className="flex h-40 items-end gap-[3px]">
          {days.map((d) => (
            <div key={d.key} className="group relative flex h-full flex-1 flex-col justify-end">
              <div
                className="rounded-t bg-royal/80 group-hover:bg-orange"
                style={{ height: `${(d.count / maxDay) * 100}%`, minHeight: d.count ? 2 : 0 }}
                title={`${d.key}: ${d.count}`}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-xs text-navy/50">
          <span>{days[0].key}</span>
          <span>today · max {maxDay}/day</span>
        </div>
      </Card>

      <Card title={`Most common questions where the bot said "I'll confirm with the team"`}>
        {stats?.confirm.length ? (
          <ol className="divide-y divide-navy/10">
            {stats.confirm.map((c) => (
              <li key={c._id} className="flex items-start justify-between gap-4 py-2.5 text-sm">
                <span>
                  {c.example}
                  {filter === "all" && <span className="ml-2 text-xs text-navy/50">({c.bots.join(", ")})</span>}
                </span>
                <span className="shrink-0 rounded-full bg-orange/15 px-2.5 py-0.5 font-semibold">{c.count}×</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-navy/60">None yet.</p>
        )}
        {!!stats?.languages.length && (
          <p className="mt-3 text-xs text-navy/60">
            Languages: {stats.languages.map((l) => `${l._id} ${l.count}`).join(" · ")}
          </p>
        )}
      </Card>

      <Card title="Recent conversations (latest 50)">
        {recent.length ? (
          <ul className="divide-y divide-navy/10">
            {recent.map((c) => (
              <li key={String(c._id)}>
                <Link
                  href={`/admin?${qs}id=${c._id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm hover:bg-offwhite"
                >
                  <span className="w-40 shrink-0 font-semibold">{formatTime(c.startTime)}</span>
                  <BotBadge bot={c.bot} />
                  <span className="text-navy/70">{formatDuration(c.durationSeconds)}</span>
                  <span className="text-navy/70">{c.userTurnCount} questions</span>
                  <span className="text-navy/70">{c.language}</span>
                  {c.saidWillConfirm && <Tag>will confirm</Tag>}
                  {c.eval && <Score label="quality" value={(c.eval.accuracy + c.eval.completeness + c.eval.relevance) / 3} />}
                  <span className="ml-auto text-royal">Open →</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-navy/60">No conversations yet.</p>
        )}
      </Card>
    </div>
  );
}

// ---------- one conversation ----------
async function Conversation({ id, filter }: { id: string; filter: Filter }) {
  const back = filter === "all" ? "/admin" : `/admin?bot=${filter}`;
  const c = ObjectId.isValid(id) ? await (await conversations()).findOne({ _id: new ObjectId(id) }) : null;
  if (!c) {
    return (
      <Card title="Not found">
        <Link href={back} className="text-royal">
          ← Back
        </Link>
      </Card>
    );
  }
  const timeline = c.sessionId
    ? await (await events()).find({ sessionId: c.sessionId }).sort({ time: 1 }).limit(50).toArray()
    : [];
  const issueByTurn = new Map((c.eval?.issues ?? []).map((i) => [i.turn, i.problem]));

  return (
    <div className="space-y-4">
      <Link href={back} className="text-sm font-semibold text-royal">
        ← Back to list
      </Link>

      <Card title={formatTime(c.startTime)}>
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-navy/70">
          <BotBadge bot={c.bot} />
          <span>Duration {formatDuration(c.durationSeconds)}</span>
          <span>Language: {c.language}</span>
          {c.endReason && <span>Ended: {c.endReason}</span>}
          {c.connectMs !== undefined && <span>Connect time {(c.connectMs / 1000).toFixed(1)}s</span>}
          {c.saidWillConfirm && <span className="font-semibold text-orange">Bot said it will confirm with the team</span>}
        </div>
        <div className="space-y-2">
          {c.turns.map((t, i) => (
            <div key={i} className={t.role === "user" ? "flex justify-end" : "flex flex-col items-start"}>
              <p
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                  t.role === "user" ? "bg-royal text-white" : "bg-offwhite ring-1 ring-navy/10"
                } ${issueByTurn.has(i) ? "ring-2 ring-red-300" : ""}`}
              >
                {t.text}
              </p>
              {issueByTurn.has(i) && <p className="mt-1 max-w-[85%] text-xs text-red-700">⚠ {issueByTurn.get(i)}</p>}
            </div>
          ))}
        </div>
      </Card>

      <Card title="Quality score" right={<ScoreOneButton id={String(c._id)} again={!!c.eval} />}>
        {c.eval ? (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              <Score label="Accuracy" value={c.eval.accuracy} />
              <Score label="Completeness" value={c.eval.completeness} />
              <Score label="Relevance" value={c.eval.relevance} />
              <Tag tone={c.eval.languageMatch ? "green" : "red"}>{c.eval.languageMatch ? "Language OK" : "Wrong language"}</Tag>
            </div>
            <p>{c.eval.summary}</p>
            <p className="text-xs text-navy/50">
              Scored {formatTime(c.eval.at)} by {c.eval.judgeModel} against prompt version {c.eval.promptVersion}
            </p>
          </div>
        ) : (
          <p className="text-sm text-navy/60">Not scored yet.</p>
        )}
      </Card>

      {timeline.length > 0 && (
        <Card
          title="Session log"
          right={
            <Link href={`/admin/logs?session=${c.sessionId}`} className="text-sm text-royal">
              Open in Logs →
            </Link>
          }
        >
          <ul className="space-y-1 font-mono text-xs">
            {timeline.map((e) => (
              <li key={String(e._id)}>
                <span className="text-navy/50">{formatClock(e.time)}</span>{" "}
                <span className={e.level === "error" ? "text-red-700" : e.level === "warn" ? "text-amber-700" : ""}>{e.type}</span>{" "}
                <span className="text-navy/60">{e.data ? JSON.stringify(e.data) : ""}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

