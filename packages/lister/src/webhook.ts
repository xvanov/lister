/**
 * Webhook signing (contract: "Auth between services").
 *   X-Signature: sha256=<hex HMAC-SHA256 of the raw body>
 *   X-Event-Id:  <uuid>  (receivers dedupe on it)
 *   X-Event-Type: listing.status
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifySignature(
  body: string,
  header: string | null,
  secret: string,
): boolean {
  if (!header) return false;
  const want = Buffer.from(signBody(body, secret));
  const got = Buffer.from(header.trim());
  return want.length === got.length && timingSafeEqual(want, got);
}

export function webhookHeaders(
  body: string,
  secret: string,
  eventId: string,
  eventType: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": "lister-webhooks/1",
    "X-Signature": signBody(body, secret),
    "X-Event-Id": eventId,
    "X-Event-Type": eventType,
  };
}
