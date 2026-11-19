import "server-only";
import { timingSafeEqual } from "node:crypto";

/** True only if `value` matches PROMOTER_PATH_SECRET (constant-time compare). */
export function isPromoterSecret(value: unknown): boolean {
  const secret = process.env.PROMOTER_PATH_SECRET;
  if (!secret || secret.length < 8 || typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
