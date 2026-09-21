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
        "business_name, logo_status, workflow_status, original_logo_url, transparent_logo_url",
      )
      .order("business_name");

    if (error) throw error;

    console.log(
      `Logo inspection links (expire in ${expiresIn} seconds)\n\n| Business | Original Logo | Transparent Logo | Logo Status | Workflow Status |\n|---|---|---|---|---|`,
    );

    for (const prospect of prospects ?? []) {
      let originalUrl = "—";
      if (prospect.original_logo_url) {
        const { data, error: signedUrlError } = await client.storage
          .from("prospect-assets")
          .createSignedUrl(prospect.original_logo_url, expiresIn);
        if (signedUrlError) throw signedUrlError;
        originalUrl = `[Open original](${data.signedUrl})`;
      }

      let transparentUrl = "—";
      if (prospect.transparent_logo_url) {
        const { data, error: signedUrlError } = await client.storage
          .from("prospect-assets")
          .createSignedUrl(prospect.transparent_logo_url, expiresIn);
        if (signedUrlError) throw signedUrlError;
        transparentUrl = `[Open transparent](${data.signedUrl})`;
      }

      console.log(
        `| ${prospect.business_name} | ${originalUrl} | ${transparentUrl} | ${prospect.logo_status ?? "—"} | ${prospect.workflow_status} |`,
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    console.error(`LOGO INSPECTION FAILED\n\n${reason}`);
    process.exitCode = 1;
  }
}
