"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, ADMIN_SESSION_SECONDS, checkAdminPassword, createAdminSession } from "@/lib/adminAuth";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export async function login(formData: FormData) {
  // 10 tries per 15 minutes per IP (kept in memory only, never stored).
  if (!rateLimit(`admin-login:${clientIp(await headers())}`, 10, 15 * 60_000)) redirect("/admin?error=wait");
  if (!checkAdminPassword(formData.get("password"))) redirect("/admin?error=1");

  (await cookies()).set(ADMIN_COOKIE, createAdminSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/admin",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  redirect("/admin");
}

export async function logout() {
  (await cookies()).delete({ name: ADMIN_COOKIE, path: "/admin" });
  redirect("/admin");
}
