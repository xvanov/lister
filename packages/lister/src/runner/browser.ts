/**
 * Browser plumbing: one persistent Chromium profile per seller account (the
 * logged-in session lives there), and screenshots per step into storage.
 *
 * A profile directory cannot be opened by two Chromium processes at once; the
 * worker's per-account lock (packages/jobs) guarantees one run per account.
 * Nothing here logs cookies, storage state or credentials.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { db } from "@repo/db";
import { env } from "@repo/env";
import { storage } from "@repo/storage";

/** The repo root (three levels above packages/lister/src/runner). */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

export function profilesRoot(): string {
  const dir = env().LISTER_PROFILES_DIR ?? "data/profiles";
  return path.isAbsolute(dir) ? dir : path.join(REPO_ROOT, dir);
}

export interface BrowserAccount {
  id: string;
  platform: string;
  externalAccountId: string;
  headless: boolean;
  profileName: string | null;
}

export function profileDir(a: BrowserAccount): string {
  const name = (a.profileName ?? a.id).replace(/[^a-z0-9_-]/gi, "_");
  return path.join(profilesRoot(), name);
}

export const MIN_FREE_BYTES = 1024 ** 3;

export async function launchAccount(
  a: BrowserAccount,
  opts: { headless?: boolean } = {},
): Promise<BrowserContext> {
  const dir = profileDir(a);
  fs.mkdirSync(dir, { recursive: true });
  const headless = opts.headless ?? a.headless;
  const display = env().LISTER_DISPLAY;
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
  if (!headless && display) childEnv.DISPLAY = display;
  return chromium.launchPersistentContext(dir, {
    headless,
    env: childEnv,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

/** Records one screenshot per step: into storage (a media_asset) and a local copy. */
export class StepRecorder {
  readonly keys: string[] = [];
  readonly localPaths: string[] = [];
  private n = 0;
  private readonly stamp = new Date().toISOString().replace(/[:.]/g, "-");

  constructor(
    private readonly organizationId: string,
    private readonly listingId: string,
    private readonly log: (msg: string) => void = console.log,
  ) {}

  async shot(page: Page, name: string): Promise<void> {
    try {
      const buf = await page.screenshot({ fullPage: false });
      await this.save(buf, name);
    } catch (err) {
      this.log(`[runner] screenshot ${name} failed: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  async save(buf: Uint8Array, name: string): Promise<void> {
    this.n++;
    const safe = name.replace(/[^a-z0-9_.-]/gi, "_");
    const file = `${String(this.n).padStart(2, "0")}-${safe}.png`;
    const key = `org/${this.organizationId}/screenshots/${this.listingId}/${this.stamp}/${file}`;
    await storage().put(key, buf, "image/png");
    await db.mediaAsset.create({
      data: {
        organizationId: this.organizationId,
        key,
        filename: file,
        contentType: "image/png",
        sizeBytes: buf.byteLength,
      },
    });
    this.keys.push(key);
    const localDir = path.join(REPO_ROOT, "data", "runs", this.listingId, this.stamp);
    try {
      fs.mkdirSync(localDir, { recursive: true });
      if (freeBytes(localDir) > MIN_FREE_BYTES) {
        const p = path.join(localDir, file);
        fs.writeFileSync(p, buf);
        this.localPaths.push(p);
      }
    } catch {
      /* the storage copy is the record; the local one is a convenience */
    }
    this.log(`[runner] step ${file}`);
  }
}

function freeBytes(dir: string): number {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** Copy the listing's photos out of storage into a temp dir, in order. */
export async function materializePhotos(
  organizationId: string,
  photoIds: string[],
): Promise<{ paths: string[]; cleanup: () => void }> {
  const rows = await db.mediaAsset.findMany({
    where: { organizationId, id: { in: photoIds } },
    select: { id: true, key: true, contentType: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lister-photos-"));
  const paths: string[] = [];
  for (const [i, id] of photoIds.entries()) {
    const row = byId.get(id);
    if (!row) throw new Error(`photo ${id} not found`);
    const ext =
      { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/heic": ".heic" }[
        row.contentType
      ] ?? ".jpg";
    const p = path.join(dir, `photo-${String(i + 1).padStart(2, "0")}${ext}`);
    fs.writeFileSync(p, await storage().get(row.key));
    paths.push(p);
  }
  return { paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export async function pageText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
}
