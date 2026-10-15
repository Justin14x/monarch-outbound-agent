import { describe, expect, it } from "vitest";

import { loadServerStitchConfig } from "../src/config/stitch.js";

describe("Stitch server configuration", () => {
  it("loads the server-side API key", () => {
    expect(loadServerStitchConfig({ STITCH_API_KEY: " test-key " })).toEqual({
      apiKey: "test-key",
    });
  });

  it("rejects a missing API key", () => {
    expect(() => loadServerStitchConfig({})).toThrow("STITCH_API_KEY is required");
  });
});
