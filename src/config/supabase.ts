export interface ServerSupabaseConfig {
  url: string;
  secretKey: string;
}

export function loadServerSupabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerSupabaseConfig {
  const url = env.SUPABASE_URL?.trim();
  const secretKey = env.SUPABASE_SECRET_KEY?.trim();

  if (!url) {
    throw new Error("SUPABASE_URL is required");
  }

  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") {
      throw new Error("Supabase must use HTTPS outside local development");
    }
  } catch (error) {
    throw new Error("SUPABASE_URL must be a valid URL", { cause: error });
  }

  if (!secretKey) {
    throw new Error("SUPABASE_SECRET_KEY is required");
  }

  if (!secretKey.startsWith("sb_secret_")) {
    throw new Error("SUPABASE_SECRET_KEY must use the sb_secret_ key format");
  }

  return { url, secretKey };
}
