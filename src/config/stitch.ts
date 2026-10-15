export interface ServerStitchConfig {
  apiKey: string;
}

export function loadServerStitchConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerStitchConfig {
  const apiKey = environment.STITCH_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("STITCH_API_KEY is required for server-side Stitch access");
  }

  return { apiKey };
}
