/**
 * `external.v1` — the API other apps call with an API key (docs/CONTRACTS.md,
 * "lister API"). Shapes are a contract shared with garage-saler and
 * communicator: change them only together.
 *
 * Every query filters on ctx.organizationId (from the key, never the input).
 */
import { enqueue, enqueueDelivery } from "@repo/jobs";
import {
  appUrl,
  createListing,
  createListingInput,
  getListing,
  listingIdInput,
  listingSelect,
  listListingsInput,
  requestAction,
  toAccountDto,
  toListingDto,
  type ListingAction,
  type ListingRow,
} from "@repo/lister";

import { apiProcedure, createTRPCRouter } from "../trpc";

async function queueAction(
  organizationId: string,
  listingId: string,
  action: ListingAction,
) {
  // attempts: 1 — a listing run is never retried by the queue (a retried
  // create could post twice). The caller asks with listings.retry.
  await enqueue(
    "listing.run",
    { organizationId, listingId, action },
    { attempts: 1 },
  );
}

const accountsRouter = createTRPCRouter({
  list: apiProcedure("accounts:read").query(async ({ ctx }) => {
    const rows = await ctx.db.sellerAccount.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toAccountDto);
  }),
});

const listingsRouter = createTRPCRouter({
  create: apiProcedure("listings:write")
    .input(createListingInput)
    .mutation(async ({ ctx, input }) => {
      const r = await createListing(
        ctx.organizationId,
        ctx.apiCaller.name,
        input,
      );
      if (r.created) {
        await enqueueDelivery(ctx.organizationId, r.deliveryId);
        await queueAction(ctx.organizationId, r.listingId, "create");
      }
      return { listingId: r.listingId, status: r.status };
    }),

  get: apiProcedure("listings:read")
    .input(listingIdInput)
    .query(async ({ ctx, input }) =>
      toListingDto(
        (await getListing(ctx.organizationId, input.listingId)) as ListingRow,
        appUrl(),
      ),
    ),

  list: apiProcedure("listings:read")
    .input(listListingsInput)
    .query(async ({ ctx, input }) => {
      const ref = input.externalRef;
      const rows = await ctx.db.listing.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(ref?.system ? { refSystem: ref.system } : {}),
          ...(ref?.kind ? { refKind: ref.kind } : {}),
          ...(ref?.id ? { refId: ref.id } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: 500,
        select: listingSelect,
      });
      return rows.map((r) => toListingDto(r as ListingRow, appUrl()));
    }),

  markSold: apiProcedure("listings:write")
    .input(listingIdInput)
    .mutation(async ({ ctx, input }) => {
      const { action } = await requestAction(
        ctx.organizationId,
        input.listingId,
        "markSold",
      );
      await queueAction(ctx.organizationId, input.listingId, action);
      return { status: "QUEUED" as const };
    }),

  remove: apiProcedure("listings:write")
    .input(listingIdInput)
    .mutation(async ({ ctx, input }) => {
      const { action } = await requestAction(
        ctx.organizationId,
        input.listingId,
        "remove",
      );
      await queueAction(ctx.organizationId, input.listingId, action);
      return { status: "QUEUED" as const };
    }),

  retry: apiProcedure("listings:write")
    .input(listingIdInput)
    .mutation(async ({ ctx, input }) => {
      const { action } = await requestAction(
        ctx.organizationId,
        input.listingId,
        "retry",
      );
      await queueAction(ctx.organizationId, input.listingId, action);
      return { status: "QUEUED" as const, action };
    }),
});

export const externalRouter = createTRPCRouter({
  v1: createTRPCRouter({
    accounts: accountsRouter,
    listings: listingsRouter,
  }),
});

export { queueAction };