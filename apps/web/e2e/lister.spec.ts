import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { signUp, uniqueEmail } from "./helpers";

/**
 * lister's core journey, through the real built app and worker (the smoke gate
 * runs the worker with LISTER_BROWSER_DRIVER=fake: same queue, jobs, storage
 * and webhooks, no real marketplace):
 *
 *   sign up → add a seller account → create an API key in the UI →
 *   upload a photo with the key → listings.create → the worker runs it →
 *   status DRY_RUN_OK → a signed listing.status webhook arrives.
 */

const SECRET = process.env.E2E_LISTER_WEBHOOK_SECRET ?? "";

interface Hook {
  sigOk: boolean;
  type: string | undefined;
  eventId: string | undefined;
  status: string;
}

function startReceiver(): Promise<{ url: string; hooks: Hook[]; close: () => void }> {
  const hooks: Hook[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const want = `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;
      let status = "";
      try {
        status = (JSON.parse(body) as { listing: { status: string } }).listing.status;
      } catch {
        /* not ours */
      }
      hooks.push({
        sigOk: req.headers["x-signature"] === want,
        type: req.headers["x-event-type"] as string | undefined,
        eventId: req.headers["x-event-id"] as string | undefined,
        status,
      });
      res.writeHead(200).end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/hook`, hooks, close: () => server.close() });
    }),
  );
}

async function trpc<T>(
  request: APIRequestContext,
  key: string,
  kind: "query" | "mutation",
  path: string,
  input?: unknown,
): Promise<{ status: number; data: T }> {
  const headers = { authorization: `Bearer ${key}` };
  const res =
    kind === "query"
      ? await request.get(`/api/trpc/${path}`, {
          headers,
          params: { input: JSON.stringify({ json: input ?? null }) },
        })
      : await request.post(`/api/trpc/${path}`, { headers, data: { json: input } });
  const body = (await res.json()) as { result?: { data: { json: T } } };
  return { status: res.status(), data: body.result?.data.json as T };
}

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("an API client posts a listing: dry run reaches DRY_RUN_OK and a signed webhook arrives", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(90_000);
  expect(SECRET, "E2E_LISTER_WEBHOOK_SECRET must be set (scripts/smoke.sh)").not.toBe("");
  const receiver = await startReceiver();
  try {
    await signUp(page, uniqueEmail("lister"), baseURL!);
    await page.goto("/app/lister");

    // A seller account (dry run by default).
    await page.getByLabel("Account label").fill("Smoke FB");
    await page.getByLabel("Facebook user id").fill("100000000000001");
    await page.getByRole("button", { name: "Add Facebook account" }).click();
    await expect(page.getByText("Smoke FB")).toBeVisible();
    await expect(page.getByText("dry run")).toBeVisible();

    // An API key, shown once.
    await page.getByLabel("API key name").fill("smoke-app");
    await page.getByRole("button", { name: "Create key" }).click();
    const key = (await page.getByTestId("new-api-key").innerText()).trim();
    expect(key).toMatch(/^lst_/);

    // No key / a wrong key: refused.
    expect((await request.get("/api/trpc/external.v1.accounts.list")).status()).toBe(401);
    expect((await trpc(request, "lst_wrong", "query", "external.v1.accounts.list")).status).toBe(401);

    const accounts = await trpc<{ id: string; liveMode: boolean; platform: string }[]>(
      request,
      key,
      "query",
      "external.v1.accounts.list",
    );
    expect(accounts.data).toHaveLength(1);
    expect(accounts.data[0]).toMatchObject({ platform: "FACEBOOK", liveMode: false });

    const up = await request.post("/api/v1/photos", {
      headers: { authorization: `Bearer ${key}` },
      multipart: { file: { name: "item.png", mimeType: "image/png", buffer: PNG } },
    });
    expect(up.status()).toBe(201);
    const { photoId } = (await up.json()) as { photoId: string };

    const input = {
      accountId: accounts.data[0]!.id,
      externalRef: { system: "smoke", kind: "item", id: `i-${Date.now()}` },
      title: "TEST — do not buy",
      description: "Smoke test listing.",
      priceCents: 500,
      category: "Miscellaneous",
      condition: "USED_GOOD",
      photoIds: [photoId],
      callbackUrl: receiver.url,
    };
    const created = await trpc<{ listingId: string; status: string }>(
      request,
      key,
      "mutation",
      "external.v1.listings.create",
      input,
    );
    expect(created.status).toBe(200);
    expect(created.data.status).toBe("QUEUED");

    // Idempotent on (accountId, externalRef).
    const again = await trpc<{ listingId: string }>(
      request,
      key,
      "mutation",
      "external.v1.listings.create",
      input,
    );
    expect(again.data.listingId).toBe(created.data.listingId);

    await expect
      .poll(
        async () =>
          (
            await trpc<{ status: string }>(request, key, "query", "external.v1.listings.get", {
              listingId: created.data.listingId,
            })
          ).data.status,
        { timeout: 45_000 },
      )
      .toBe("DRY_RUN_OK");

    const listing = await trpc<{ screenshots: string[]; externalRef: { system: string } }>(
      request,
      key,
      "query",
      "external.v1.listings.get",
      { listingId: created.data.listingId },
    );
    expect(listing.data.externalRef.system).toBe("smoke");
    expect(listing.data.screenshots.length).toBeGreaterThan(0);
    const shot = await request.get(listing.data.screenshots[0]!.replace(/^https?:\/\/[^/]+/, ""), {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(shot.status()).toBe(200);

    await expect
      .poll(() => receiver.hooks.filter((h) => h.status === "DRY_RUN_OK").length, { timeout: 30_000 })
      .toBe(1);
    expect(receiver.hooks.every((h) => h.sigOk && h.type === "listing.status" && h.eventId)).toBe(true);
    expect(receiver.hooks.map((h) => h.status)).toEqual(
      expect.arrayContaining(["QUEUED", "POSTING", "DRY_RUN_OK"]),
    );

    // The operator UI shows it too.
    await page.reload();
    await expect(page.getByTestId(`listing-status-${created.data.listingId}`)).toHaveText("DRY_RUN_OK");
  } finally {
    receiver.close();
  }
});
