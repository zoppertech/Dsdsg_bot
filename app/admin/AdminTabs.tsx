"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/quality", label: "Quality" },
  { href: "/admin/logs", label: "Logs" },
];

export default function AdminTabs() {
  const path = usePathname();
  return (
    <nav className="flex gap-1" aria-label="Admin sections">
      {TABS.map((t) => {
        const active = t.href === "/admin" ? path === "/admin" : path.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ${active ? "bg-white text-navy" : "text-white/80 hover:bg-white/10"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
