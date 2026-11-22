import type { ListingStatus } from "../contract";
import type { BrowserAccount, StepRecorder } from "./browser";

export interface RunAccount extends BrowserAccount {
  liveMode: boolean;
}

export interface RunListing {
  id: string;
  organizationId: string;
  title: string;
  description: string;
  priceCents: number;
  category: string;
  condition: string;
  location: string | null;
  platformListingId: string | null;
  url: string | null;
}

export interface RunContext {
  account: RunAccount;
  listing: RunListing;
  /** Local files, in posting order (first = cover). Empty for markSold/remove. */
  photos: string[];
  rec: StepRecorder;
  log: (msg: string) => void;
}

export interface RunResult {
  status: ListingStatus;
  platformListingId?: string | null;
  url?: string | null;
  lastError?: string | null;
  /** The session is gone: the account goes to NEEDS_LOGIN. */
  needsLogin?: boolean;
}

export interface SessionCheck {
  ok: boolean;
  reason?: string;
}

export interface PlatformAdapter {
  create(ctx: RunContext): Promise<RunResult>;
  markSold(ctx: RunContext): Promise<RunResult>;
  remove(ctx: RunContext): Promise<RunResult>;
  checkSession(account: RunAccount): Promise<SessionCheck>;
}

/** Thrown inside an adapter for a stop a human must resolve (login, checkpoint, captcha). */
export class NeedsHumanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsHumanError";
  }
}
