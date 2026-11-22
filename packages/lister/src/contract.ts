/**
 * The lister API contract (docs/CONTRACTS.md, "lister API"). Input schemas and
 * the wire shapes of Account and Listing. Two other services build against
 * these: change a shape only together with them.
 */
import { z } from "zod";

export const PLATFORMS = ["FACEBOOK", "CRAIGSLIST"] as const;
export const ACCOUNT_STATUSES = ["NEEDS_LOGIN", "READY", "PAUSED"] as const;
export const LISTING_STATUSES = [
  "QUEUED",
  "POSTING",
  "LIVE",
  "DRY_RUN_OK",
  "FAILED",
  "SOLD",
  "REMOVED",
] as const;
export const CONDITIONS = [
  "NEW",
  "USED_LIKE_NEW",
  "USED_GOOD",
  "USED_FAIR",
] as const;

export type Platform = (typeof PLATFORMS)[number];
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export type Condition = (typeof CONDITIONS)[number];

/** Scopes an API client can hold. */
export const SCOPES = [
  "accounts:read",
  "listings:read",
  "listings:write",
] as const;
export type Scope = (typeof SCOPES)[number];

export const externalRefSchema = z.object({
  system: z.string().trim().min(1).max(100),
  kind: z.string().trim().min(1).max(100),
  id: z.string().trim().min(1).max(200),
});
export type ExternalRef = z.infer<typeof externalRefSchema>;

export const createListingInput = z.object({
  accountId: z.string().min(1),
  externalRef: externalRefSchema,
  title: z.string().trim().min(1).max(100),
  description: z.string().max(5000),
  priceCents: z.number().int().min(0).max(100_000_000),
  category: z.string().trim().min(1).max(100),
  condition: z.enum(CONDITIONS),
  location: z.string().trim().max(200).optional(),
  photoIds: z.array(z.string().min(1)).min(1).max(10),
  callbackUrl: z.string().url().max(2000),
});
export type CreateListingInput = z.infer<typeof createListingInput>;

export const listingIdInput = z.object({ listingId: z.string().min(1) });

export const listListingsInput = z
  .object({
    externalRef: externalRefSchema.partial().optional(),
    status: z.enum(LISTING_STATUSES).optional(),
  })
  .default({});

export interface AccountDto {
  id: string;
  platform: Platform;
  label: string;
  externalAccountId: string;
  status: AccountStatus;
  liveMode: boolean;
}

export interface ListingDto {
  id: string;
  accountId: string;
  platform: Platform;
  externalRef: ExternalRef;
  title: string;
  priceCents: number;
  status: ListingStatus;
  platformListingId?: string;
  url?: string;
  lastError?: string;
  screenshots: string[];
  updatedAt: string;
}

export interface ListingStatusEvent {
  eventId: string;
  type: "listing.status";
  listing: ListingDto;
}

/** The DB row fields toListingDto reads. */
export interface ListingRow {
  id: string;
  accountId: string;
  platform: Platform;
  refSystem: string;
  refKind: string;
  refId: string;
  title: string;
  priceCents: number;
  status: ListingStatus;
  platformListingId: string | null;
  url: string | null;
  lastError: string | null;
  screenshotKeys: string[];
  updatedAt: Date;
}

/** A screenshot's URL: the media route, which accepts the same Bearer key. */
export function screenshotUrl(appUrl: string, key: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/media/blob?key=${encodeURIComponent(key)}`;
}

export function toListingDto(row: ListingRow, appUrl: string): ListingDto {
  return {
    id: row.id,
    accountId: row.accountId,
    platform: row.platform,
    externalRef: { system: row.refSystem, kind: row.refKind, id: row.refId },
    title: row.title,
    priceCents: row.priceCents,
    status: row.status,
    ...(row.platformListingId
      ? { platformListingId: row.platformListingId }
      : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    screenshots: row.screenshotKeys.map((k) => screenshotUrl(appUrl, k)),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAccountDto(row: AccountDto): AccountDto {
  return {
    id: row.id,
    platform: row.platform,
    label: row.label,
    externalAccountId: row.externalAccountId,
    status: row.status,
    liveMode: row.liveMode,
  };
}
