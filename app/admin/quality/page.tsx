import Link from "next/link";
import { ObjectId } from "mongodb";
import { isAdmin } from "@/lib/adminAuth";
import { GOLDEN_ITEMS, summarize } from "@/lib/evaluation";
import { conversations, evalRuns, type EvalRunDoc, type GoldenResult, type RunSummary } from "@/lib/mongodb";
import { FinishRunButton, RerunButton, RunGoldenButton, ScoreChatsButton } from "../EvalControls";
import Login from "../Login";
import { BotBadge, BotFilter, Card, formatTime, parseFilter, Pct, Score, Stat, Tag, type Filter } from "../ui";

export const dynamic = "force-dynamic";

type Search = { bot?: string; run?: string; failed?: string };
type WithId<T> = T & { _id: ObjectId };

export default async function QualityPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  if (!(await isAdmin())) return <Login />;
  const filter = parseFilter(sp.bot);
  try {
    if (sp.run && ObjectId.isValid(sp.run)) return await RunDetail({ runId: sp.run, onlyFailed: sp.failed === "1" });
    return (
      <>
        <BotFilter filter={filter} base="/admin/quality" />
        {await Overview({ filter })}
      </>
    );
  } catch (err) {
    console.error("[admin/quality] failed:", err instanceof Error ? err.message : "unknown error");
    return <p className="rounded-2xl bg-orange/15 p-4 text-sm">Couldn&apos;t load quality data. Check the Logs tab.</p>;
  }
}

/** Summary of a run, limited to one bot when a filter is set. */
function runSummary(run: EvalRunDoc, filter: Filter): RunSummary | null {
  if (filter === "all") return run.summary ?? (run.results.length ? summarize(run.results) : null);
  const rs = run.results.filter((r) => r.bot === filter);
  return rs.length ? summarize(rs) : null;
}

const quality = (r: { accuracy: number; completeness: number; relevance: number }) => (r.accuracy + r.completeness + r.relevance) / 3;

// ---------- overview ----------
async function Overview({ filter }: { filter: Filter }) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const match = filter === "all" ? {} : { bot: filter };
  const runsCol = await evalRuns();
  const convCol = await conversations();

  const [runs, real, unscored, weakest] = await Promise.all([
    runsCol.find({}, { projection: { "results.answer": 0, "results.expected": 0 } }).sort({ startedAt: -1 }).limit(20).toArray(),
    convCol
      .aggregate<{ count: number; accuracy: number; completeness: number; relevance: number; language: number }>([
        { $match: { ...match, eval: { $exists: true }, startTime: { $gte: since } } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            accuracy: { $avg: "$eval.accuracy" },
            completeness: { $avg: "$eval.completeness" },
            relevance: { $avg: "$eval.relevance" },
            language: { $avg: { $cond: ["$eval.languageMatch", 1, 0] } },
          },
        },
      ])
      .toArray(),
    convCol.countDocuments({ ...match, eval: { $exists: false } }),
    convCol
      .aggregate<WithId<{ bot: string; startTime: Date; score: number; summary: string }>>([
        { $match: { ...match, eval: { $exists: true } } },
        {
          $project: {
            bot: 1,
            startTime: 1,
            summary: "$eval.summary",
            score: { $avg: ["$eval.accuracy", "$eval.completeness", "$eval.relevance"] },
          },
        },
        { $sort: { score: 1, startTime: -1 } },
        { $limit: 10 },
      ])
      .toArray(),
  ]);

  // Only full runs count as "latest" / "previous"; partial re-runs are shown in the history only.
  const doneRuns = runs.filter((r) => r.status === "done" && !r.partial && runSummary(r, filter));
  const latest = doneRuns[0];
  const previous = doneRuns[1];
  const latestS = latest ? runSummary(latest, filter) : null;
  const prevS = previous ? runSummary(previous, filter) : null;
  const realS = real[0];
  const counts = {
    all: GOLDEN_ITEMS.length,
    customer: GOLDEN_ITEMS.filter((i) => i.bot === "customer").length,
    promoter: GOLDEN_ITEMS.filter((i) => i.bot === "promoter").length,
  };

  const rows: { label: string; latest?: number; prev?: number; real?: number; kind: "score" | "pct" }[] = [
    { label: "Accuracy (facts match the knowledge base)", latest: latestS?.accuracy, prev: prevS?.accuracy, real: realS?.accuracy, kind: "score" },
    { label: "Completeness (key points covered)", latest: latestS?.completeness, prev: prevS?.completeness, real: realS?.completeness, kind: "score" },
    { label: "Relevance (answers what was asked)", latest: latestS?.relevance, prev: prevS?.relevance, real: realS?.relevance, kind: "score" },
    { label: "Replied in the right language", latest: latestS?.languageMatchRate, prev: prevS?.languageMatchRate, real: realS?.language, kind: "pct" },
    { label: "Pass rate (golden test only)", latest: latestS?.passRate, prev: prevS?.passRate, kind: "pct" },
  ];

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Golden test pass rate" value={latestS ? `${Math.round(latestS.passRate * 100)}%` : "–"} hint={latest ? formatTime(latest.startedAt) : "No run yet"} />
        <Stat label="Golden quality" value={latestS ? `${quality(latestS).toFixed(1)} / 5` : "–"} hint="Accuracy, completeness, relevance" />
        <Stat label="Real chats quality (30 days)" value={realS ? `${quality(realS).toFixed(1)} / 5` : "–"} hint={realS ? `${realS.count} chats scored` : "None scored yet"} />
        <Stat label="Chats not scored yet" value={unscored.toLocaleString("en-IN")} />
      </section>

      <Card title="Golden test (fixed questions with known correct answers)">
        <p className="mb-3 text-sm text-navy/70">
          Asks the real voice bot {counts.all} fixed questions from <code>evals/golden-set.json</code> in several languages, then an AI judge
          compares each answer with the correct key points. Run it after every prompt change and compare with the previous run.
        </p>
        <RunGoldenButton counts={counts} />
      </Card>

      <Card title="Golden test vs real chats">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-navy/60">
              <tr>
                <th className="py-2 pr-3 font-medium">Metric</th>
                <th className="py-2 pr-3 font-medium">Latest golden run</th>
                <th className="py-2 pr-3 font-medium">Previous golden run</th>
                <th className="py-2 font-medium">Real chats (last 30 days)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy/10">
              {rows.map((r) => (
                <tr key={r.label}>
                  <td className="py-2 pr-3">{r.label}</td>
                  <td className="py-2 pr-3">
                    {r.kind === "score" ? <Score value={r.latest} /> : <Pct value={r.latest} />}
                    <Delta now={r.latest} before={r.prev} pct={r.kind === "pct"} />
                  </td>
                  <td className="py-2 pr-3">{r.kind === "score" ? <Score value={r.prev} /> : <Pct value={r.prev} />}</td>
                  <td className="py-2">{r.label.startsWith("Pass") ? <span className="text-navy/40">n/a</span> : r.kind === "score" ? <Score value={r.real} /> : <Pct value={r.real} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-navy/50">
          Scores are 1–5 (green 4+, amber 3+, red below). If real chats score much lower than the golden test, customers are asking things the
          golden set does not cover yet: add those questions to it.
        </p>
      </Card>

      <Card title="Golden test history">
        {runs.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-navy/60">
                <tr>
                  <th className="py-2 pr-3 font-medium">Started</th>
                  <th className="py-2 pr-3 font-medium">Bots</th>
                  <th className="py-2 pr-3 font-medium">Prompt version</th>
                  <th className="py-2 pr-3 font-medium">Pass</th>
                  <th className="py-2 pr-3 font-medium">Quality</th>
                  <th className="py-2 pr-3 font-medium">Language</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy/10">
                {runs.map((r) => {
                  const s = runSummary(r, filter);
                  return (
                    <tr key={String(r._id)}>
                      <td className="py-2 pr-3 whitespace-nowrap">{formatTime(r.startedAt)}</td>
                      <td className="py-2 pr-3">{r.bots.join(", ")}</td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {Object.entries(r.promptVersions).map(([b, v]) => `${b[0]}:${v}`).join(" ")}
                      </td>
                      <td className="py-2 pr-3">{s ? <Pct value={s.passRate} /> : "–"}</td>
                      <td className="py-2 pr-3">{s ? <Score value={quality(s)} /> : "–"}</td>
                      <td className="py-2 pr-3">{s ? <Pct value={s.languageMatchRate} /> : "–"}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {r.partial && <Tag tone="grey">re-run</Tag>}{" "}
                        {r.status === "running" && <Tag tone="grey">incomplete</Tag>}{" "}
                        {s && s.errors > 0 && <Tag tone="red">{s.errors} errors</Tag>}{" "}
                        <Link href={`/admin/quality?run=${r._id}`} className="text-royal">
                          Open →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-navy/60">No runs yet. Click “Run golden test” above.</p>
        )}
      </Card>

      <Card title="Real chats" right={<ScoreChatsButton bot={filter} unscored={unscored} />}>
        <p className="mb-3 text-sm text-navy/70">
          The AI judge reads saved conversations and checks the bot&apos;s replies against the knowledge base. Each chat costs one small Gemini call.
        </p>
        <h3 className="mb-2 text-sm font-semibold">Weakest scored chats</h3>
        {weakest.length ? (
          <ul className="divide-y divide-navy/10">
            {weakest.map((w) => (
              <li key={String(w._id)}>
                <Link href={`/admin?id=${w._id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm hover:bg-offwhite">
                  <span className="w-40 shrink-0">{formatTime(w.startTime)}</span>
                  <BotBadge bot={w.bot} />
                  <Score value={w.score} />
                  <span className="min-w-0 flex-1 truncate text-navy/70">{w.summary}</span>
                  <span className="text-royal">Open →</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-navy/60">No scored chats yet.</p>
        )}
      </Card>
    </div>
  );
}

function Delta({ now, before, pct }: { now?: number; before?: number; pct?: boolean }) {
  if (now === undefined || before === undefined) return null;
  const d = pct ? Math.round((now - before) * 100) : Math.round((now - before) * 10) / 10;
  if (d === 0) return <span className="ml-2 text-xs text-navy/40">same</span>;
  return (
    <span className={`ml-2 text-xs font-semibold ${d > 0 ? "text-emerald-700" : "text-red-700"}`}>
      {d > 0 ? "▲" : "▼"} {Math.abs(d)}
      {pct ? "%" : ""}
    </span>
  );
}

// ---------- one run ----------
async function RunDetail({ runId, onlyFailed }: { runId: string; onlyFailed: boolean }) {
  const col = await evalRuns();
  const run = await col.findOne({ _id: new ObjectId(runId) });
  if (!run) {
    return (
      <Card title="Run not found">
        <Link href="/admin/quality" className="text-royal">
          ← Back
        </Link>
      </Card>
    );
  }
  // Compare with the run before this one, question by question.
  const prev = await col.findOne({ status: "done", partial: { $ne: true }, startedAt: { $lt: run.startedAt } }, { sort: { startedAt: -1 } });
  const prevById = new Map((prev?.results ?? []).map((r) => [r.itemId, r]));
  const order = new Map(run.itemIds.map((id, i) => [id, i]));
  const results = [...run.results]
    .sort((a, b) => (order.get(a.itemId) ?? 0) - (order.get(b.itemId) ?? 0))
    .filter((r) => !onlyFailed || !r.pass);
  const s = run.summary ?? summarize(run.results);
  const fixed = run.results.filter((r) => r.pass && prevById.get(r.itemId) && !prevById.get(r.itemId)!.pass).length;
  const broke = run.results.filter((r) => !r.pass && prevById.get(r.itemId)?.pass).length;
  const base = `/admin/quality?run=${runId}`;
  const failedIds = run.results.filter((r) => !r.pass).map((r) => r.itemId);

  return (
    <div className="space-y-4">
      <Link href="/admin/quality" className="text-sm font-semibold text-royal">
        ← Back to Quality
      </Link>
      <Card title={`Golden run · ${formatTime(run.startedAt)}`}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            Pass rate <Pct value={s.passRate} />
          </span>
          <Score label="Accuracy" value={s.accuracy} />
          <Score label="Completeness" value={s.completeness} />
          <Score label="Relevance" value={s.relevance} />
          <span>
            Language <Pct value={s.languageMatchRate} />
          </span>
          {s.errors > 0 && <Tag tone="red">{s.errors} errors</Tag>}
        </div>
        <p className="mt-2 text-xs text-navy/50">
          {run.results.length}/{run.itemIds.length} questions · bot model {run.liveModel} · judge {run.judgeModel} · prompt{" "}
          {Object.entries(run.promptVersions).map(([b, v]) => `${b} ${v}`).join(", ")}
        </p>
        {prev && (
          <p className="mt-1 text-sm">
            Compared with the run of {formatTime(prev.startedAt)}: <span className="font-semibold text-emerald-700">{fixed} now pass</span>,{" "}
            <span className="font-semibold text-red-700">{broke} now fail</span>.
          </p>
        )}
        {run.status === "running" && (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-amber-800">This run did not finish (the page was closed or a request timed out).</p>
            <FinishRunButton runId={runId} />
          </div>
        )}
        {failedIds.length > 0 && run.status === "done" && (
          <div className="mt-3">
            <RerunButton itemIds={failedIds} label={`Re-run only the ${failedIds.length} not passed (cheaper)`} />
          </div>
        )}
        <div className="mt-3 flex gap-2 text-sm">
          <Link href={base} className={`rounded-full px-3 py-1 ring-1 ${!onlyFailed ? "bg-royal text-white ring-royal" : "ring-navy/15"}`}>
            All
          </Link>
          <Link href={`${base}&failed=1`} className={`rounded-full px-3 py-1 ring-1 ${onlyFailed ? "bg-royal text-white ring-royal" : "ring-navy/15"}`}>
            Not passed only
          </Link>
        </div>
      </Card>

      {results.map((r) => (
        <ResultRow key={r.itemId} r={r} prev={prevById.get(r.itemId)} />
      ))}
      {results.length === 0 && <p className="text-sm text-navy/60">Nothing to show.</p>}
    </div>
  );
}

function ResultRow({ r, prev }: { r: GoldenResult; prev?: GoldenResult }) {
  const changed = prev && prev.pass !== r.pass;
  return (
    <section className={`rounded-2xl bg-white p-4 text-sm shadow-sm ring-1 ${r.pass ? "ring-navy/5" : "ring-red-200"}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-navy/50">{r.itemId}</span>
        <BotBadge bot={r.bot} />
        <Tag tone="grey">{r.language}</Tag>
        {r.error ? <Tag tone="red">error</Tag> : r.pass ? <Tag tone="green">pass</Tag> : <Tag tone="red">not passed</Tag>}
        {changed && <Tag tone={r.pass ? "green" : "red"}>{r.pass ? "fixed since last run" : "broke since last run"}</Tag>}
        {!r.error && (
          <span className="ml-auto flex flex-wrap gap-1">
            <Score label="Acc" value={r.accuracy} />
            <Score label="Comp" value={r.completeness} />
            <Score label="Rel" value={r.relevance} />
            <Tag tone={r.languageMatch ? "green" : "red"}>{r.languageMatch ? "lang ok" : "wrong lang"}</Tag>
          </span>
        )}
      </div>
      <p className="font-semibold">Q: {r.question}</p>
      <p className="mt-1 whitespace-pre-wrap rounded-xl bg-offwhite px-3 py-2">{r.answer || <span className="text-navy/40">(no answer)</span>}</p>
      {r.error && <p className="mt-2 text-red-700">Error: {r.error}</p>}
      {r.reason && <p className="mt-2 text-navy/80">{r.reason}</p>}
      {r.hallucinations.length > 0 && (
        <p className="mt-1 text-red-700">Not in knowledge base: {r.hallucinations.join(" · ")}</p>
      )}
      {r.missing.length > 0 && <p className="mt-1 text-amber-800">Missing: {r.missing.join(" · ")}</p>}
      <details className="mt-2 text-xs text-navy/60">
        <summary className="cursor-pointer">Expected key points{prev ? " · previous answer" : ""}</summary>
        <p className="mt-1">{r.expected}</p>
        {prev && (
          <p className="mt-2">
            <span className="font-semibold">Previous answer ({prev.pass ? "pass" : "not passed"}):</span> {prev.answer}
          </p>
        )}
      </details>
    </section>
  );
}
