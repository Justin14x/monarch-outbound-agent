import { getServerSupabaseClient } from "../lib/supabase/server.js";

const rawExpiration = process.argv[2];
const expiresIn = rawExpiration === undefined ? 3_600 : Number(rawExpiration);

if (
  !Number.isInteger(expiresIn) ||
  expiresIn < 60 ||
  expiresIn > 604_800
) {
  console.error("Usage: npm run logos:inspect -- <seconds: 60-604800>");
  process.exitCode = 1;
} else {
  try {
    const client = getServerSupabaseClient();
    const { data: prospects, error } = await client
      .from("prospects")
      .select(
        "business_name, website, logo_status, logo_source_url, original_logo_url",
      )
      .order("business_name");

    if (error) throw error;

    console.log(
      `Logo inspection links (expire in ${expiresIn} seconds)\n\n| Business | Logo Status | Source URL | Supabase Location | Inspect Saved Logo |\n|---|---|---|---|---|`,
    );

    for (const prospect of prospects ?? []) {
      let inspectionUrl = "—";
      if (prospect.original_logo_url) {
        const { data, error: signedUrlError } = await client.storage
          .from("prospect-assets")
          .createSignedUrl(prospect.original_logo_url, expiresIn);
        if (signedUrlError) throw signedUrlError;
        inspectionUrl = `[Open saved logo](${data.signedUrl})`;
      }

      console.log(
        `| ${prospect.business_name} | ${prospect.logo_status ?? "—"} | ${prospect.logo_source_url ?? "—"} | ${prospect.original_logo_url ?? "—"} | ${inspectionUrl} |`,
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    console.error(`LOGO INSPECTION FAILED\n\n${reason}`);
    process.exitCode = 1;
  }
}
