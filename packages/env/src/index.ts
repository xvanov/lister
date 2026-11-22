/**
 * Validated server environment.
 *
 * Import `env()` — never `process.env` — anywhere on the server. Validation is
 * lazy (first call) so that merely importing this module from a client bundle
 * or a build step cannot crash; and it is cached so the cost is paid once.
 *
 * A missing or malformed variable fails here with a readable list, instead of
 * surfacing 400 lines deeper as an undefined connection string.
 */
import { z } from "zod";

/**
 * A boolean env var: "true"/"1" or "false"/"0" (any case); blank or absent =
 * `fallback`. Anything else FAILS rather than quietly meaning false: with a
 * loose parser `REQUIRE_EMAIL_VERIFICATION=yes` would switch verification OFF.
 */
function bool(fallback: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v, ctx) => {
      const b = v === undefined ? null : parseBool(v);
      if (b === undefined) {
        ctx.addIssue({ code: "custom", message: BOOL_HINT(v) });
        return z.NEVER;
      }
      return b ?? fallback;
    });
}

const BOOL_HINT = (v: unknown) =>
  `must be "true"/"1" or "false"/"0" (got ${JSON.stringify(v)})`;

/** true/false; null for blank; undefined for anything unrecognised. */
function parseBool(v: boolean | string): boolean | null | undefined {
  if (typeof v === "boolean") return v;
  const s = v.trim().toLowerCase();
  if (s === "") return null;
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return undefined;
}

/** `VAR=` in a .env file means "unset", not "the empty string". */
const blankIsUnset = (v: unknown) => (v === "" ? undefined : v);

/** An optional URL where `VAR=` (blank) means unset instead of "invalid URL". */
const optionalUrl = z.preprocess(blankIsUnset, z.string().url().optional());

/** A base64 string that decodes to exactly 32 bytes (an AES-256 key). */
const base64Key = z
  .string()
  .refine(
    (v) => Buffer.from(v, "base64").length === 32,
    "must be base64 of exactly 32 bytes (openssl rand -base64 32)",
  );

const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  APP_URL: z.string().url().default("http://localhost:3240"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  /** Jobs the worker runs in parallel. Bounded so a typo cannot fork-bomb Redis. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),


  BETTER_AUTH_SECRET: z
    .string()
    .min(
      32,
      "BETTER_AUTH_SECRET must be at least 32 chars (openssl rand -base64 32)",
    ),
  BETTER_AUTH_URL: optionalUrl,

  /**
   * Extra origins allowed to complete an auth round trip, comma-separated.
   * Needed whenever the app is reachable on an origin other than APP_URL — a
   * Cloudflare tunnel, a preview deploy, a LAN address for phone testing.
   * Kept explicit rather than wildcarded: this list is a CSRF boundary.
   */
  TRUSTED_ORIGINS: z.string().optional(),

  /**
   * Require a confirmed email address before a password sign-in succeeds.
   *
   * ON by default: it is the only thing stopping someone from signing up as
   * somebody else's address. Turn it off only for a throwaway environment.
   */
  REQUIRE_EMAIL_VERIFICATION: bool(true),

  // SMTP. Unset SMTP_HOST = mail is logged to the console instead of sent, so a
  // fresh clone runs with no mail infrastructure. `docker compose up -d mailpit`
  // gives you a real local SMTP server and inbox.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(1097),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** The From of every email, whichever transport sends it (SMTP or Resend). */
  SMTP_FROM: z.string().default("Lister <no-reply@localhost>"),

  /**
   * Which transport sends email (packages/email/src/transport.ts):
   *   smtp    SMTP_* above (Mailpit locally; any relay in production). Default.
   *   resend  Resend's API, with RESEND_API_KEY. SMTP_FROM must be on a
   *           domain verified in Resend.
   */
  EMAIL_TRANSPORT: z.preprocess(
    blankIsUnset,
    z.enum(["smtp", "resend"]).default("smtp"),
  ),
  RESEND_API_KEY: z.preprocess(blankIsUnset, z.string().optional()),
  /**
   * Signing secret of the Resend webhook (`whsec_...`, shown when the webhook
   * is created). Resend signs with Svix; /api/webhooks/email-events verifies
   * it. Unset in production = Resend's webhooks are refused.
   */
  RESEND_WEBHOOK_SECRET: z.preprocess(
    blankIsUnset,
    z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/=]+$/, "must be the whsec_... signing secret")
      .optional(),
  ),


  /**
   * URL of a local dev mail inbox (Mailpit). When set, the "confirm your email"
   * screen links straight to it.
   *
   * This exists because the failure it prevents is guaranteed otherwise: mail
   * goes to a local catcher that never delivers onward, so a user checks their
   * real inbox, sees nothing, and concludes the feature is broken. Leave it
   * unset in production — the link would be meaningless and the hint misleading.
   */
  DEV_MAIL_INBOX_URL: optionalUrl,

  // Auth rate limiting, per IP. Kept ON in every environment — brute-forcing a
  // password endpoint is the cheapest attack there is. The knobs exist because
  // the smoke gate is itself a single-IP load generator; raise them there, not
  // in production.
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  // Google OAuth is optional: absent means the button is hidden and
  // email+password remains the only sign-in method.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),


  // ── Display formatting (apps/web/src/lib/format.ts) ────────────────────
  // How money, dates and numbers are shown to users. Server-side defaults for
  // the whole app; the /app layout hands them to client components.
  /** BCP 47 locale, e.g. en-US, en-GB, de-DE. */
  APP_LOCALE: z.preprocess(
    blankIsUnset,
    z
      .string()
      .default("en-US")
      .refine((v) => {
        try {
          return Intl.getCanonicalLocales(v).length === 1;
        } catch {
          return false;
        }
      }, "must be a BCP 47 locale tag such as en-US"),
  ),
  /** ISO 4217 currency code, e.g. USD, EUR, GBP, JPY. */
  APP_CURRENCY: z.preprocess(
    blankIsUnset,
    z
      .string()
      .regex(/^[A-Z]{3}$/, "must be a 3-letter ISO 4217 code such as USD")
      .default("USD"),
  ),
  /** IANA timezone used for "today" and for rendering instants, e.g. America/New_York. */
  APP_TIMEZONE: z.preprocess(
    blankIsUnset,
    z
      .string()
      .default("UTC")
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, "must be an IANA timezone such as Europe/London"),
  ),

  /**
   * What is running: shown by /api/health and `deploy.sh status`. Deploys set
   * it to the git commit; unset = the root package.json version.
   */
  APP_VERSION: z.preprocess(blankIsUnset, z.string().optional()),


  // ── Outbound messages (packages/outbound) ──────────────────────────────
  // Every email/SMS/push passes ONE guard. See docs/guide.md "Outbound messages".

  /**
   * Safe mode: only allowlisted recipients get real messages; everyone else is
   * logged as blocked. true = strict, false = off, local = allow everyone
   * because SMTP is a local catcher (Mailpit; refused in production). Unset =
   * off in production, strict everywhere else. Resolved by `resolveSafeMode`
   * in packages/outbound.
   */
  OUTBOUND_SAFE_MODE: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v, ctx): boolean | "local" | undefined => {
      if (v === undefined) return undefined;
      if (typeof v === "string" && v.trim().toLowerCase() === "local")
        return "local";
      const b = parseBool(v);
      if (b === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `must be "local", "true"/"1" or "false"/"0" (got ${JSON.stringify(v)})`,
        });
        return z.NEVER;
      }
      return b ?? undefined;
    }),
  /** Comma-separated: exact addresses/numbers, or `@domain` for a whole domain. */
  OUTBOUND_SAFE_RECIPIENTS: z.string().optional(),
  /** Channel switch. On by default: sign-up needs it. */
  OUTBOUND_EMAIL_ENABLED: bool(true),
  /** Channel switch for push (ntfy). On by default; nothing pushes until NTFY_TOPIC is set. */
  OUTBOUND_PUSH_ENABLED: bool(true),
  /** Channel switch for SMS (Twilio). OFF by default: texts cost money and reach phones. */
  OUTBOUND_SMS_ENABLED: bool(false),
  /**
   * Channel switch for mobile push (Expo push, packages/push-mobile). OFF by
   * default: it reaches real phones, through Expo's and Apple's/Google's servers.
   */
  OUTBOUND_MOBILE_PUSH_ENABLED: bool(false),
  /** Global kill switch. A runtime switch also exists (`npm run outbound:freeze`). */
  OUTBOUND_FROZEN: bool(false),
  /** Volume caps (fixed windows in Redis). Over the cap = blocked, not queued. */
  OUTBOUND_CAP_RECIPIENT_PER_HOUR: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  OUTBOUND_CAP_ORG_PER_HOUR: z.coerce.number().int().positive().default(200),
  OUTBOUND_CAP_ORG_PER_DAY: z.coerce.number().int().positive().default(2000),
  OUTBOUND_CAP_GLOBAL_PER_HOUR: z.coerce
    .number()
    .int()
    .positive()
    .default(2000),

  // ── Operator notifications (packages/notify) ───────────────────────────
  // Alerts for whoever RUNS the app (a job failed for good, a tenant hit the AI
  // cap). Push via ntfy when NTFY_TOPIC is set, else email to OPERATOR_EMAIL,
  // else the console. See docs/guide.md "Operator notifications".

  /** ntfy server. Self-host it, or use the public one with a long random topic. */
  NTFY_URL: z.preprocess(
    blankIsUnset,
    z.string().url().default("https://ntfy.sh"),
  ),
  /**
   * The topic is the password on a public server: anyone who knows it reads
   * every message. Make it long and random (`openssl rand -hex 16`).
   */
  NTFY_TOPIC: z.preprocess(
    blankIsUnset,
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 of A-Z a-z 0-9 _ -")
      .optional(),
  ),
  /** Access token for a protected topic (sent as a Bearer token). */
  NTFY_TOKEN: z.preprocess(blankIsUnset, z.string().optional()),
  /** Where operator notifications go by email when no ntfy topic is set. */
  OPERATOR_EMAIL: z.preprocess(blankIsUnset, z.string().email().optional()),
  /** The same dedupeKey within this many minutes is recorded, not re-sent. */
  NOTIFY_DEDUPE_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),
  /**
   * When held notifications (low priority, or held by the volume cap) are sent
   * as one digest: comma-separated HH:MM in APP_TIMEZONE.
   */
  NOTIFY_DIGEST_TIMES: z.preprocess(
    blankIsUnset,
    z
      .string()
      .default("09:00")
      .refine(
        (v) =>
          v
            .split(",")
            .every((t) => /^([01]?\d|2[0-3])(:[0-5]\d)?$/.test(t.trim())),
        'must be comma-separated HH:MM times, e.g. "09:00,17:00"',
      ),
  ),


  // ── Security helpers (packages/security) ───────────────────────────────
  /** Bearer secret for HTTP cron endpoints. Unset in production = every call refused. */
  CRON_SECRET: z.string().optional(),
  /** HMAC secret for the email-provider events webhook (bounces, complaints). */
  EMAIL_WEBHOOK_SECRET: z.string().optional(),
  /**
   * AES-256-GCM key for sealing third-party tokens at rest: base64 of 32 bytes
   * (`openssl rand -base64 32`). Rotate by moving the old key into
   * SECRETS_ENCRYPTION_OLD_KEYS (comma-separated); old ciphertexts still open.
   */
  SECRETS_ENCRYPTION_KEY: z.preprocess(blankIsUnset, base64Key.optional()),
  SECRETS_ENCRYPTION_OLD_KEYS: z.string().optional(),

  // Storage
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ENDPOINT: optionalUrl,
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;

/**
 * Every variable the schema reads. Tests clear exactly these, and a test checks
 * each is in turbo.json's globalEnv (turbo's strict env mode drops the rest).
 */
export const serverEnvKeys = Object.keys(
  serverSchema.shape,
) as (keyof ServerEnv)[];

/**
 * Optional URL settings that are present but BLANK (`SOME_URL=`, as copied
 * from .env.example) are removed from the environment, so "blank" means
 * "unset" for every reader — not only for env(). Third-party SDKs read some
 * of these themselves at import time: `@ai-sdk/openai` builds a default
 * provider from its base-URL variable when the module loads, and throws
 * "baseURL must be a non-empty string" on a blank one, which took the
 * production server down at boot. Runs when this module is first evaluated,
 * so it must be imported before such SDKs.
 */
export function dropBlankOptionalUrls(
  target: Record<string, string | undefined> = process.env,
): string[] {
  const dropped: string[] = [];
  for (const [key, schema] of Object.entries(serverSchema.shape)) {
    if (!/(_URL|_ENDPOINT)$/.test(key)) continue;
    const v = target[key];
    if (v === undefined || v.trim() !== "") continue;
    if (!schema.safeParse(undefined).success) continue; // required: let env() say so
    delete target[key];
    dropped.push(key);
  }
  return dropped;
}
dropBlankOptionalUrls();

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (cached) return cached;

  dropBlankOptionalUrls();
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(
      `Invalid environment.\n${lines.join("\n")}\n\n` +
        `Fix your .env (start from .env.example, or run \`npm run setup\`).`,
    );
  }

  // The schema owns every variable; this reads the key only to say it is missing.
  // eslint-disable-next-line no-restricted-syntax
  const resendKey = parsed.data.RESEND_API_KEY;
  if (parsed.data.EMAIL_TRANSPORT === "resend" && !resendKey) {
    throw new Error("EMAIL_TRANSPORT=resend but RESEND_API_KEY is unset");
  }

  // S3 driver needs its credentials; catching it here beats a 500 on upload.
  if (parsed.data.STORAGE_DRIVER === "s3") {
    const missing = (
      ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const
    ).filter((k) => !parsed.data[k]);
    if (missing.length) {
      throw new Error(
        `STORAGE_DRIVER=s3 but these are unset: ${missing.join(", ")}`,
      );
    }
  }

  cached = parsed.data;
  return cached;
}

/** True when the "Continue with Google" button should be rendered. */
export function googleEnabled(): boolean {
  const e = env();
  return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
}

/** Test-only: drop the memoised value so a test can re-validate. */
export function resetEnvCache(): void {
  cached = undefined;
}
