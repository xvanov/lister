/**
 * Run one listing action NOW in this terminal (instead of through the queue),
 * holding the account's lock like the worker does. The account's liveMode
 * decides dry run vs real, exactly as in the worker.
 *
 *   npm run listing:run -- <listingId> create|markSold|remove|renew
 *
 * Screenshot paths are printed at the end (data/runs/<listingId>/<time>/).
 */
import "@repo/env/load";

import { db } from "@repo/db";
import { closeQueue, runListing } from "@repo/jobs";
import { requestAction, type ListingAction } from "@repo/lister";

const ACTIONS = ["create", "markSold", "remove", "renew"] as const;

async function main() {
  const [listingId, action] = process.argv.slice(2);
  if (!listingId || !ACTIONS.includes(action as ListingAction))
    throw new Error(`usage: npm run listing:run -- <listingId> ${ACTIONS.join("|")}`);
  const row = await db.listing.findUnique({
    where: { id: listingId },
    select: { organizationId: true, account: { select: { label: true, liveMode: true } } },
  });
  if (!row) throw new Error(`listing ${listingId} not found`);
  console.log(
    `${action} on "${row.account.label}" — ${row.account.liveMode ? "LIVE: the final button WILL be clicked" : "dry run (stops before the final click)"}`,
  );
  await requestAction(row.organizationId, listingId, action === "create" ? "retry" : (action as ListingAction));
  const r = await runListing({ organizationId: row.organizationId, listingId, action: action as ListingAction }).catch(
    (err: Error) => ({ failed: err.message }),
  );
  console.log(JSON.stringify(r));
  const after = await db.listing.findUnique({ where: { id: listingId }, select: { status: true, lastError: true } });
  console.log(`→ ${after?.status}${after?.lastError ? `: ${after.lastError}` : ""}`);
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
