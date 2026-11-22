/**
 * Who is calling: an API key (Authorization: Bearer <key>) mapped to one
 * organization and a set of scopes. Two sources:
 *   1. LISTER_API_CLIENTS in .env (JSON; `org` = the org's id or slug; an id
 *      survives renaming the org)
 *   2. the api_client table (keys created in the UI; only a SHA-256 is kept)
 * The tenant always comes from the key, never from the request body.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@repo/db";
import { env } from "@repo/env";

import { SCOPES, type Scope } from "./contract";

export interface ApiCaller {
  name: string;
  organizationId: string;
  scopes: Scope[];
  /** Signs this caller's webhooks; null = LISTER_WEBHOOK_SECRET. */
  webhookSecret: string | null;
}

const envClientSchema = z.array(
  z.object({
    name: z.string().min(1),
    key: z.string().min(16, "an API key must be at least 16 characters"),
    org: z.string().min(1),
    scopes: z.array(z.enum(SCOPES)).min(1),
    webhookSecret: z.string().min(16).optional(),
  }),
);
export type EnvApiClient = z.infer<typeof envClientSchema>[number];

/** Parse LISTER_API_CLIENTS. Throws a readable error (never echoing a key). */
export function parseEnvClients(raw: string | undefined): EnvApiClient[] {
  if (!raw || !raw.trim()) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      "LISTER_API_CLIENTS is not valid JSON (quote it with single quotes in .env)",
    );
  }
  const parsed = envClientSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`LISTER_API_CLIENTS is invalid: ${where}`);
  }
  return parsed.data;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function sameSecret(a: string, b: string): boolean {
  const ha = Buffer.from(hashKey(a), "hex");
  const hb = Buffer.from(hashKey(b), "hex");
  return timingSafeEqual(ha, hb);
}

/** A new random key for the UI: shown once, stored hashed. */
export function generateApiKey(): string {
  return `lst_${randomBytes(24).toString("base64url")}`;
}

export function bearerToken(headers: Headers): string | null {
  const h = headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m?.[1] ?? null;
}

/** Resolve a key to its caller, or null. */
export async function resolveApiKey(key: string): Promise<ApiCaller | null> {
  if (!key) return null;
  for (const c of parseEnvClients(env().LISTER_API_CLIENTS)) {
    if (!sameSecret(c.key, key)) continue;
    const org = await db.organization.findFirst({
      where: { OR: [{ id: c.org }, { slug: c.org }] },
      select: { id: true },
    });
    if (!org) return null;
    return {
      name: c.name,
      organizationId: org.id,
      scopes: c.scopes,
      webhookSecret: c.webhookSecret ?? null,
    };
  }
  const row = await db.apiClient.findUnique({
    where: { keyHash: hashKey(key) },
    select: {
      id: true,
      name: true,
      organizationId: true,
      scopes: true,
      revokedAt: true,
    },
  });
  if (!row || row.revokedAt) return null;
  await db.apiClient
    .updateMany({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return {
    name: row.name,
    organizationId: row.organizationId,
    scopes: row.scopes.filter((s): s is Scope =>
      (SCOPES as readonly string[]).includes(s),
    ),
    webhookSecret: null,
  };
}

export async function resolveBearer(
  headers: Headers,
): Promise<ApiCaller | null> {
  const key = bearerToken(headers);
  return key ? resolveApiKey(key) : null;
}

/** The secret that signs webhooks for listings created by `clientName`. */
export function webhookSecretFor(clientName: string | null): string | null {
  if (clientName) {
    const c = parseEnvClients(env().LISTER_API_CLIENTS).find(
      (x) => x.name === clientName,
    );
    if (c?.webhookSecret) return c.webhookSecret;
  }
  return env().LISTER_WEBHOOK_SECRET ?? null;
}
