import OpenAI from "openai";

import { loadServerOpenAIConfig } from "../../config/openai.js";

let singleton: OpenAI | undefined;

export function getServerOpenAIClient(): OpenAI {
  if (singleton) return singleton;

  const { apiKey } = loadServerOpenAIConfig();
  singleton = new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: 10 * 60 * 1_000,
  });
  return singleton;
}
