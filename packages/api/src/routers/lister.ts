/**
 * The operator UI's API (signed-in users, orgProcedure): seller accounts, API
 * keys, and the listings of this workspace. Calling apps use `external.v1`.
 */
import { z } from "zod";
import { enqueue } from "@repo/jobs";
import {
  appUrl,
  craigslistSettingsSchema,
  generateApiKey,
  hashKey,
  listingSelect,
  PLATFORMS,
  requestAction,
  SCOPES,
  toListingDto,
  type ListingRow,
} from "@repo/lister";

import { Prisma } from "@repo/db";

import { DomainRuleError, NotFoundError } from "../errors";
import { createTRPCRouter, orgProcedure, adminOnlyProcedure } from "../trpc";
import { queueAction } from "./external";

const accountId = z.object({ accountId: z.string().min(1) });

export const listerRouter = createTRPCRouter({
  accounts: orgProcedure.query(({ ctx }) =>
    ctx.db.sellerAccount.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        platform: true,
        label: true,
        externalAccountId: true,
        status: true,
        liveMode: true,
        headless: true,
        lastError: true,
        lastCheckedAt: true,
        settings: true,
      },
    }),
  ),

  createAccount: adminOnlyProcedure("add seller accounts")
    .input(
      z.object({
        platform: z.enum(PLATFORMS),
        label: z.string().trim().min(1).max(100),
        externalAccountId: z.string().trim().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.sellerAccount.create({
        data: { ...input, organizationId: ctx.organizationId },
        select: { id: true },
      });
      await ctx.audit("seller_account.create", { targetId: row.id });
      return row;
    }),

  /**
   * label, settings, liveMode, headless, pause. Turning liveMode ON means
   * Publish gets clicked. `settings` (JSON) is validated per platform
   * (Craigslist: contactEmail, area, subarea, city, postal, chat, phone, pacing).
   */
  updateAccount: adminOnlyProcedure("change seller accounts")
    .input(
      accountId.extend({
        label: z.string().trim().min(1).max(100).optional(),
        settings: z.record(z.string(), z.unknown()).nullable().optional(),
        liveMode: z.boolean().optional(),
        headless: z.boolean().optional(),
        paused: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let settings: object | null | undefined = input.settings;
      if (input.settings) {
        const acct = await ctx.db.sellerAccount.findFirst({
          where: { id: input.accountId, organizationId: ctx.organizationId },
          select: { platform: true },
        });
        if (!acct) throw new NotFoundError("Account not found.");
        if (acct.platform === "CRAIGSLIST") {
          const r = craigslistSettingsSchema.safeParse(input.settings);
          if (!r.success)
            throw new DomainRuleError(
              `Invalid Craigslist settings: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            );
          // Store only what was given; defaults apply at run time.
          settings = input.settings;
        }
      }
      const { count } = await ctx.db.sellerAccount.updateMany({
        where: { id: input.accountId, organizationId: ctx.organizationId },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(settings !== undefined ? { settings: settings === null ? Prisma.DbNull : settings } : {}),
          ...(input.liveMode !== undefined ? { liveMode: input.liveMode } : {}),
          ...(input.headless !== undefined ? { headless: input.headless } : {}),
          ...(input.paused !== undefined
            ? { status: input.paused ? "PAUSED" : "NEEDS_LOGIN" }
            : {}),
        },
      });
      if (count === 0) throw new NotFoundError("Account not found.");
      await ctx.audit("seller_account.update", {
        targetId: input.accountId,
        metadata: {
          label: input.label ?? null,
          settingsChanged: input.settings !== undefined,
          liveMode: input.liveMode ?? null,
          headless: input.headless ?? null,
          paused: input.paused ?? null,
        },
      });
      return { ok: true };
    }),

  checkAccount: orgProcedure.input(accountId).mutation(async ({ ctx, input }) => {
    const a = await ctx.db.sellerAccount.findFirst({
      where: { id: input.accountId, organizationId: ctx.organizationId },
      select: { id: true },
    });
    if (!a) throw new NotFoundError("Account not found.");
    const jobId = await enqueue(
      "account.check",
      { organizationId: ctx.organizationId, accountId: a.id },
      { attempts: 1 },
    );
    return { jobId };
  }),

  apiClients: orgProcedure.query(({ ctx }) =>
    ctx.db.apiClient.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        revokedAt: true,
        lastUsedAt: true,
        createdAt: true,
      },
    }),
  ),

  /** Returns the key ONCE; only its hash is stored. */
  createApiClient: adminOnlyProcedure("create API keys")
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        scopes: z.array(z.enum(SCOPES)).min(1).default([...SCOPES]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const key = generateApiKey();
      const row = await ctx.db.apiClient.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          scopes: input.scopes,
          keyHash: hashKey(key),
          keyPrefix: key.slice(0, 8),
        },
        select: { id: true },
      });
      await ctx.audit("api_client.create", { targetId: row.id });
      return { id: row.id, key };
    }),

  revokeApiClient: adminOnlyProcedure("revoke API keys")
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { count } = await ctx.db.apiClient.updateMany({
        where: { id: input.id, organizationId: ctx.organizationId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) throw new NotFoundError("API key not found.");
      await ctx.audit("api_client.revoke", { targetId: input.id });
      return { ok: true };
    }),

  listings: orgProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.listing.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: { ...listingSelect, account: { select: { label: true, liveMode: true } } },
    });
    return rows.map((r) => ({
      ...toListingDto(r as ListingRow, appUrl()),
      accountLabel: r.account.label,
      pendingAction: r.pendingAction,
      screenshotKeys: r.screenshotKeys,
    }));
  }),

  listingAction: orgProcedure
    .input(
      z.object({
        listingId: z.string().min(1),
        action: z.enum(["markSold", "remove", "renew", "retry"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { action } = await requestAction(
        ctx.organizationId,
        input.listingId,
        input.action,
      );
      await queueAction(ctx.organizationId, input.listingId, action);
      await ctx.audit(`listing.${input.action}`, { targetId: input.listingId });
      return { action };
    }),
});
