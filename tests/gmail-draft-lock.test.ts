import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withGmailDraftLock } from "../src/lib/gmail/draft-lock.js";

describe("Gmail local draft lock", () => {
  it("rejects overlapping runs and releases the lock after success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "monarch-gmail-test-"));
    const path = join(directory, "draft.lock");
    try {
      await withGmailDraftLock(async () => {
        await expect(withGmailDraftLock(async () => "duplicate", path))
          .rejects.toThrow("Another Gmail draft run");
      }, path);
      expect(await withGmailDraftLock(async () => "next", path)).toBe("next");
    } finally {
      await rmdir(directory);
    }
  });

  it("releases the lock after a caught operation failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "monarch-gmail-test-"));
    const path = join(directory, "draft.lock");
    try {
      await expect(withGmailDraftLock(async () => { throw new Error("network failure"); }, path))
        .rejects.toThrow("network failure");
      expect(await withGmailDraftLock(async () => "reconcile", path)).toBe("reconcile");
    } finally {
      await rmdir(directory);
    }
  });
});
