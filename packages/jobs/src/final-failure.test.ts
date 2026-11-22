import { describe, expect, it } from "vitest";

const marked: unknown[] = [];

const { finalFailureHook } = await import("./worker");

describe("finalFailureHook", () => {

  it("ignores jobs without a hook, unknown names and invalid payloads", async () => {
    marked.length = 0;
    await finalFailureHook(
      { id: "2", name: "maintenance.nightly", data: {}, attemptsMade: 1 },
      new Error("x"),
    );
    await finalFailureHook(
      { id: "3", name: "nope", data: {}, attemptsMade: 1 },
      new Error("x"),
    );
    expect(marked).toEqual([]);
  });
});
