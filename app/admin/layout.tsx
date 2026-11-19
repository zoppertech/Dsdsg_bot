import type { Metadata } from "next";
import { isAdmin } from "@/lib/adminAuth";
import { logout } from "./actions";
import AdminTabs from "./AdminTabs";

// Renders <meta name="robots" content="noindex, nofollow"> on every admin page.
export const metadata: Metadata = {
  title: "Admin · Zopper AI Assistant",
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Not logged in: each page shows the login form itself.
  if (!(await isAdmin())) return children;
  return (
    <div className="min-h-dvh bg-offwhite text-navy">
      <header className="bg-navy text-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-4">
            <p className="font-heading text-xl font-bold">
              zopper<span className="text-orange">.</span> <span className="text-white/70">admin</span>
            </p>
            <AdminTabs />
          </div>
          <form action={logout}>
            <button className="rounded-full bg-white/15 px-4 py-2 text-sm font-semibold ring-1 ring-white/20">Log out</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
