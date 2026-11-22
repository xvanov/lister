import { describe, expect, it } from "vitest";

import { parseEnvClients } from "../src/api-clients";
import { findMoneyStep, guardClick } from "../src/runner/guard";
import { signBody, verifySignature, webhookHeaders } from "../src/webhook";

describe("guardClick", () => {
  it("never clicks spending or promotion buttons", () => {
    for (const l of ["Boost listing", "Pay now", "Buy", "Promote", "Checkout"])
      expect(guardClick(l, { live: true, finalStep: /.*/ }).allowed).toBe(false);
  });
  it("a dry run never publishes, marks sold or deletes", () => {
    for (const l of ["Publish", "Mark as sold", "Delete listing", "Post"])
      expect(guardClick(l, { live: false }).allowed).toBe(false);
    expect(guardClick("Next", { live: false }).allowed).toBe(true);
  });
  it("a live run clicks a publishing label only as the named final step", () => {
    expect(guardClick("Publish", { live: true }).allowed).toBe(false);
    expect(guardClick("Publish", { live: true, finalStep: /^publish$/i }).allowed).toBe(true);
    expect(guardClick("Delete listing", { live: true, finalStep: /^publish$/i }).allowed).toBe(false);
  });
  it("a dry run may click a label that only opens a confirmation, never the confirm", () => {
    expect(guardClick("Delete listing", { live: false, opensConfirm: /^delete listing$/i }).allowed).toBe(true);
    expect(guardClick("Delete", { live: false, opensConfirm: /^delete listing$/i }).allowed).toBe(false);
    expect(guardClick("Boost listing", { live: false, opensConfirm: /.*/ }).allowed).toBe(false);
  });
  it("refuses unlabelled controls", () => {
    expect(guardClick("  ", { live: true }).allowed).toBe(false);
  });
  it("spots money steps", () => {
    expect(findMoneyStep("Boost your listing for $5")).toBeTruthy();
    expect(findMoneyStep("List in more places Marketplace $5")).toBeNull();
  });
});

describe("webhook signature", () => {
  const body = JSON.stringify({ eventId: "e1", type: "listing.status" });
  it("is sha256=<hex HMAC of the raw body>", () => {
    expect(signBody(body, "s3cret")).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(body, signBody(body, "s3cret"), "s3cret")).toBe(true);
    expect(verifySignature(body + " ", signBody(body, "s3cret"), "s3cret")).toBe(false);
    expect(verifySignature(body, signBody(body, "other"), "s3cret")).toBe(false);
  });
  it("carries the event headers", () => {
    const h = webhookHeaders(body, "s", "e1", "listing.status");
    expect(h).toMatchObject({ "X-Event-Id": "e1", "X-Event-Type": "listing.status" });
  });
});

describe("LISTER_API_CLIENTS", () => {
  it("parses clients and rejects bad config without echoing the key", () => {
    const key = "k".repeat(32);
    expect(parseEnvClients(JSON.stringify([{ name: "a", key, org: "o", scopes: ["listings:read"] }]))).toHaveLength(1);
    expect(parseEnvClients("")).toEqual([]);
    expect(() => parseEnvClients("not json")).toThrow(/not valid JSON/);
    try {
      parseEnvClients(JSON.stringify([{ name: "a", key: "short", org: "o", scopes: ["nope"] }]));
    } catch (e) {
      expect((e as Error).message).not.toContain("short");
    }
  });
});
