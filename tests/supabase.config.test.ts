import { describe, expect, it } from "vitest";

import { loadServerSupabaseConfig } from "../src/config/supabase.js";

describe("Supabase configuration", () => {
  it("loads a valid project URL and publishable key", () => {
    expect(
      loadServerSupabaseConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SECRET_KEY: "sb_secret_test",
      }),
    ).toEqual({
      url: "https://example.supabase.co",
      secretKey: "sb_secret_test",
    });
  });

  it("rejects missing configuration", () => {
    expect(() => loadServerSupabaseConfig({})).toThrow(
      "SUPABASE_URL is required",
    );
  });

  it("rejects publishable and legacy keys for the server client", () => {
    expect(() =>
      loadServerSupabaseConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SECRET_KEY: "sb_publishable_wrong_key",
      }),
    ).toThrow("SUPABASE_SECRET_KEY must use the sb_secret_ key format");
  });
});
