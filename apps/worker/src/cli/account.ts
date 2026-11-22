/**
 * Seller-account chores from the terminal:
 *
 *   npm run account:login -- <accountId>      headed browser on the account's
 *                                             profile; log in, then close it
 *   npm run account:check -- <accountId>      check the session → READY / NEEDS_LOGIN
 *   npm run account:live -- <accountId> on|off   flip liveMode (on = Publish gets clicked)
 *   npm run account:headless -- <accountId> on|off
 *   npm run account:list
 *   npm run account:settings -- <accountId> ['{"contactEmail":"..."}']   show / merge settings JSON
 *
 * login and check take the same per-account lock as the worker, so they never
 * open a profile a running job is using.
 */
import "@repo/env/load";

import { db } from "@repo/db";
import { closeQueue, withAccountLock } from "@repo/jobs";
import { craigslistSettings } from "@repo/lister";
import { checkAccount, launchAccount, profileDir } from "@repo/lister/runner";

const LOGIN_URL: Record<string, string> = {
  FACEBOOK: "https://www.facebook.com/login",
  CRAIGSLIST: "https://accounts.craigslist.org/login",
};

async function account(id: string | undefined) {
  if (!id) throw new Error("usage: <command> <accountId>");
  const a = await db.sellerAccount.findUnique({ where: { id } });
  if (!a) throw new Error(`account ${id} not found (npm run account:list)`);
  return a;
}

function onOff(v: string | undefined): boolean {
  if (v === "on") return true;
  if (v === "off") return false;
  throw new Error('say "on" or "off"');
}

async function main() {
  const [cmd, id, arg] = process.argv.slice(2);
  switch (cmd) {
    case "list": {
      for (const a of await db.sellerAccount.findMany({ orderBy: { createdAt: "asc" } }))
        console.log(
          `${a.id}  ${a.platform}  "${a.label}"  ${a.externalAccountId}  ${a.status}  liveMode=${a.liveMode} headless=${a.headless}${a.lastError ? `  (${a.lastError})` : ""}`,
        );
      break;
    }
    case "login": {
      const a = await account(id);
      await withAccountLock(a.id, async () => {
        console.log(`Opening a browser on ${profileDir(a)}`);
        console.log("Log in (and approve any check), then CLOSE the browser window.");
        const ctx = await launchAccount(a, { headless: false });
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        await page.goto(LOGIN_URL[a.platform] ?? "about:blank").catch(() => undefined);
        await new Promise<void>((resolve) => ctx.on("close", () => resolve()));
      }, { waitMs: 60_000 });
      const r = await withAccountLock(a.id, () => checkAccount(a.organizationId, a.id));
      console.log(r.ok ? "Session OK → READY" : `Still not logged in: ${r.reason} → NEEDS_LOGIN`);
      break;
    }
    case "check": {
      const a = await account(id);
      const r = await withAccountLock(a.id, () => checkAccount(a.organizationId, a.id), { waitMs: 60_000 });
      console.log(r.ok ? "READY" : `NEEDS_LOGIN: ${r.reason}`);
      break;
    }
    case "live": {
      const a = await account(id);
      const liveMode = onOff(arg);
      await db.sellerAccount.update({ where: { id: a.id }, data: { liveMode } });
      console.log(`"${a.label}" liveMode=${liveMode}${liveMode ? "  ← listings will really be PUBLISHED" : " (dry run)"}`);
      break;
    }
    case "settings": {
      const a = await account(id);
      if (arg) {
        const patch = JSON.parse(arg) as Record<string, unknown>;
        const merged = { ...((a.settings as Record<string, unknown> | null) ?? {}), ...patch };
        if (a.platform === "CRAIGSLIST") craigslistSettings(merged); // throws a readable error
        await db.sellerAccount.update({ where: { id: a.id }, data: { settings: merged as object } });
        console.log(JSON.stringify(merged, null, 2));
      } else console.log(JSON.stringify(a.settings ?? {}, null, 2));
      break;
    }
    case "headless": {
      const a = await account(id);
      const headless = onOff(arg);
      await db.sellerAccount.update({ where: { id: a.id }, data: { headless } });
      console.log(`"${a.label}" headless=${headless}`);
      break;
    }
    default:
      throw new Error("commands: list | login <id> | check <id> | live <id> on|off | headless <id> on|off | settings <id> [json]");
  }
}

main()
  .then(async () => {
    await closeQueue();
    await db.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeQueue().catch(() => undefined);
    process.exit(1);
  });
