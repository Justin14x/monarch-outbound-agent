import { describe, expect, it } from "vitest";

import { loadServerOpenAIConfig } from "../src/config/openai.js";

describe("OpenAI server configuration", () => {
  it("loads the server-only API key", () => {
    expect(loadServerOpenAIConfig({ OPENAI_API_KEY: "sk-test" })).toEqual({
      apiKey: "sk-test",
    });
  });

  it("rejects a missing API key", () => {
    expect(() => loadServerOpenAIConfig({})).toThrow(
      "OPENAI_API_KEY is required",
    );
  });
});
