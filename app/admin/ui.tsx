// Small display pieces shared by the admin pages (server-safe, no hooks).
import Link from "next/link";

export const TZ = "Asia/Kolkata";
export type Filter = "all" | "customer" | "promoter";

export function parseFilter(v: string | undefined): Filter {
  return v === "customer" || v === "promoter" ? v : "all";
}

export function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-navy/5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-lg font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, small }: { label: string; value: string; hint?: string; small?: boolean }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-navy/5">
      <p className="text-xs text-navy/60">{label}</p>
      <p className={`mt-1 font-heading font-bold ${small ? "text-sm leading-snug" : "text-2xl"}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-navy/50">{hint}</p>}
    </div>
  );
}

export function BotBadge({ bot }: { bot: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${
        bot === "promoter" ? "bg-navy text-white" : "bg-royal/15 text-royal"
      }`}
    >
      {bot}
    </span>
  );
}

/** A 1–5 score with a colour: green 4+, amber 3+, red below. */
export function Score({ value, label }: { value: number | null | undefined; label?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return <span className="text-navy/40">{label ? `${label} –` : "–"}</span>;
  }
  const tone = value >= 4 ? "bg-emerald-100 text-emerald-800" : value >= 3 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {label ? `${label} ` : ""}
      {value.toFixed(1)}
    </span>
  );
}

export function Pct({ value, good = 0.8, ok = 0.6 }: { value: number | null | undefined; good?: number; ok?: number }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className="text-navy/40">–</span>;
  const tone = value >= good ? "text-emerald-700" : value >= ok ? "text-amber-700" : "text-red-700";
  return <span className={`font-semibold ${tone}`}>{Math.round(value * 100)}%</span>;
}

export function Tag({ children, tone = "orange" }: { children: React.ReactNode; tone?: "orange" | "red" | "green" | "grey" }) {
  const cls = {
    orange: "bg-orange/15 text-navy",
    red: "bg-red-100 text-red-800",
    green: "bg-emerald-100 text-emerald-800",
    grey: "bg-navy/10 text-navy/70",
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

export function dayKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
}

export function lastDays(n: number): string[] {
  return Array.from({ length: n }, (_, i) => dayKey(new Date(Date.now() - (n - 1 - i) * 86_400_000)));
}

export function formatTime(d: Date | undefined): string {
  if (!d) return "–";
  return new Intl.DateTimeFormat("en-IN", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function formatClock(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);
}

export function formatDuration(seconds: number | null | undefined): string {
  const s = Math.round(seconds ?? 0);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function BotFilter({ filter, base }: { filter: Filter; base: string }) {
  return (
    <nav className="mb-6 flex gap-2" aria-label="Filter by bot">
      {(["all", "customer", "promoter"] as const).map((f) => (
        <Link
          key={f}
          href={f === "all" ? base : `${base}?bot=${f}`}
          className={`rounded-full px-4 py-2 text-sm font-semibold capitalize ring-1 ${
            f === filter ? "bg-royal text-white ring-royal" : "bg-white ring-navy/15"
          }`}
        >
          {f}
        </Link>
      ))}
    </nav>
  );
}
