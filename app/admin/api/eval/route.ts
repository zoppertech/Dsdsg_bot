import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/adminAuth";
import { isBotId, promptVersion, requireEnv, type BotId } from "@/lib/bots";
import { evaluateConversation, evaluateGoldenItem, GOLDEN_ITEMS, judgeModel, summarize } from "@/lib/evaluation";
import { errorMessage, logEvent } from "@/lib/events";
import { conversations, evalRuns } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One golden question = one Live session (~20 s) + one judge call. Needs more than the default timeout.
export const maxDuration = 60;

// Lives under /admin so the admin cookie (path=/admin, SameSite=Strict) is sent and checked.
// The Quality page calls this one step at a time, so no single request runs for long.
export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  try {
    switch (body.action) {
      // Create a golden run and return the questions to run.
      case "start": {
        const bots: BotId[] = isBotId(String(body.bot)) ? [body.bot as BotId] : ["customer", "promoter"];
        // Optional list of question ids, to re-run only some (e.g. the ones that failed last time).
        const only = Array.isArray(body.itemIds) ? new Set(body.itemIds.filter((x): x is string => typeof x === "string")) : null;
        const items = GOLDEN_ITEMS.filter((i) => bots.includes(i.bot) && (!only || only.has(i.id)));
        if (!items.length) return NextResponse.json({ error: "No questions selected" }, { status: 400 });
        const versions: Partial<Record<BotId, string>> = {};
        for (const b of bots) versions[b] = await promptVersion(b);
        const { insertedId } = await (await evalRuns()).insertOne({
          startedAt: new Date(),
          status: "running",
          partial: !!only,
          bots,
          itemIds: items.map((i) => i.id),
          promptVersions: versions,
          liveModel: requireEnv("GEMINI_LIVE_MODEL"),
          judgeModel: judgeModel(),
          results: [],
        });
        await logEvent({ type: "eval_run_started", data: { runId: String(insertedId), questions: items.length } });
        return NextResponse.json({ runId: String(insertedId), itemIds: items.map((i) => i.id) });
      }

      // Run one question of a golden run.
      case "item": {
        const runId = objectId(body.runId);
        const item = GOLDEN_ITEMS.find((i) => i.id === body.itemId);
        if (!runId || !item) return NextResponse.json({ error: "Bad request" }, { status: 400 });
        const result = await evaluateGoldenItem(item);
        if (result.error) {
          await logEvent({ type: "eval_error", level: "error", bot: item.bot, data: { item: item.id, message: result.error } });
        }
        // Store once per question, even if the page retries.
        await (await evalRuns()).updateOne(
          { _id: runId, "results.itemId": { $ne: item.id } },
          { $push: { results: result } },
        );
        return NextResponse.json({ itemId: item.id, pass: result.pass, error: result.error ?? null });
      }

      // Close a golden run and store its averages.
      case "finish": {
        const runId = objectId(body.runId);
        const col = await evalRuns();
        const run = runId ? await col.findOne({ _id: runId }) : null;
        if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
        const summary = summarize(run.results);
        await col.updateOne({ _id: run._id }, { $set: { status: "done", finishedAt: new Date(), summary } });
        await logEvent({
          type: "eval_run_finished",
          data: { runId: String(run._id), passRate: Math.round(summary.passRate * 100), errors: summary.errors },
        });
        return NextResponse.json({ summary });
      }

      // Latest saved conversations that have no score yet.
      case "unscored": {
        const limit = Math.max(1, Math.min(Number(body.limit) || 20, 100));
        const filter = isBotId(String(body.bot)) ? { bot: body.bot as BotId } : {};
        const docs = await (await conversations())
          .find({ ...filter, eval: { $exists: false } }, { projection: { _id: 1 } })
          .sort({ startTime: -1 })
          .limit(limit)
          .toArray();
        return NextResponse.json({ ids: docs.map((d) => String(d._id)) });
      }

      // Score one real conversation.
      case "score": {
        const id = objectId(body.id);
        const col = await conversations();
        const c = id ? await col.findOne({ _id: id }) : null;
        if (!c) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
        const evaluation = await evaluateConversation(c, await promptVersion(c.bot));
        await col.updateOne({ _id: c._id }, { $set: { eval: evaluation } });
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    await logEvent({ type: "eval_error", level: "error", data: { action: String(body.action), message: errorMessage(err) } });
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}

function objectId(v: unknown): ObjectId | null {
  return typeof v === "string" && ObjectId.isValid(v) ? new ObjectId(v) : null;
}
