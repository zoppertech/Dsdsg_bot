import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const ADMIN_COOKIE = "admin_session";
export const ADMIN_SESSION_SECONDS = 12 * 60 * 60; // log in again after 12 hours

function password(): string | null {
  const p = process.env.ADMIN_PASSWORD;
  return p && p.length >= 8 ? p : null; // refuse to work with a missing or very short password
}

function sign(value: string, pw: string): string {
  return createHmac("sha256", pw).update(`admin-session:${value}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Constant-time password check. */
export function checkAdminPassword(input: unknown): boolean {
  const pw = password();
  if (!pw || typeof input !== "string") return false;
  // Compare HMACs so the inputs always have the same length.
  return safeEqual(sign(input, "cmp"), sign(pw, "cmp"));
}

/** Cookie value = expiry + signature. Signed with ADMIN_PASSWORD, so changing it logs everyone out. */
export function createAdminSession(): string {
  const pw = password();
  if (!pw) throw new Error("ADMIN_PASSWORD is not set");
  const exp = String(Date.now() + ADMIN_SESSION_SECONDS * 1000);
  return `${exp}.${sign(exp, pw)}`;
}

export async function isAdmin(): Promise<boolean> {
  const pw = password();
  const value = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!pw || !value) return false;
  const [exp, mac] = value.split(".");
  if (!exp || !mac || !(Number(exp) > Date.now())) return false;
  return safeEqual(mac, sign(exp, pw));
}
