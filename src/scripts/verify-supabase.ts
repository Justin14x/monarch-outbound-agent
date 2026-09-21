import { getServerSupabaseClient } from "../lib/supabase/server.js";

const client = getServerSupabaseClient();
const [prospectsResult, bucketResult] = await Promise.all([
  client.from("prospects").select("id", { count: "exact", head: true }),
  client.storage.getBucket("prospect-assets"),
]);

if (prospectsResult.error) {
  throw new Error(`Supabase connection failed: ${prospectsResult.error.message}`, {
    cause: prospectsResult.error,
  });
}

if (bucketResult.error) {
  throw new Error(`Supabase Storage check failed: ${bucketResult.error.message}`, {
    cause: bucketResult.error,
  });
}

console.log(
  `Supabase verified. Prospects: ${prospectsResult.count ?? 0}; bucket: ${bucketResult.data.name}`,
);
