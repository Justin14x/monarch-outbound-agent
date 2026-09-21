export interface ServerOpenAIConfig {
  apiKey: string;
}

export function loadServerOpenAIConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerOpenAIConfig {
  const apiKey = env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  return { apiKey };
}
