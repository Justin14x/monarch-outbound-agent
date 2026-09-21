# Monarch Outbound Agent

Monarch Outbound Agent is a private TypeScript backend for processing Monarch Systems prospects. Supabase is the system of record after the initial CSV import.

## V1 scope

The current foundation supports one workflow:

```text
CSV import
  -> official website logo discovery
  -> transparent PNG logo processing
  -> upload original + transparent logos to Supabase Storage
  -> Stitch app generation from website + transparent logo + Monarch prompt
  -> retrieve and store Stitch images
  -> verified public email discovery
  -> personalized email generation
  -> Gmail draft
  -> review and approval
  -> send
```

The Supabase foundation, CSV prospect importer, and official-logo finder are implemented. Transparent-background processing, Stitch, email discovery, email generation, and Gmail are intentionally not implemented.

## Architecture

- `supabase/migrations/` is the authoritative, replayable database history.
- `src/types/database.generated.ts` is generated from the live Supabase schema.
- `src/lib/supabase/server.ts` owns the application's single reusable server-side client.
- `src/modules/prospects/` owns prospect types and CRUD operations.
- `src/modules/prospects/prospect.csv-import.ts` owns CSV validation, deduplication, and row-level import results.
- `src/modules/prospects/website-normalization.ts` owns website parsing and normalized-domain generation.
- `src/modules/logos/logo-finder.ts` extracts, ranks, downloads, and validates official-logo candidates.
- `src/modules/logos/safe-http.ts` applies timeouts, response-size limits, redirect checks, and private-network blocking to website requests.
- `src/modules/logos/logo-processor.ts` owns batch state transitions and Supabase Storage upload/read-back verification.
- `src/scripts/import-prospects.ts` is the command-line entry point for imports.
- `src/scripts/find-logos.ts` is the command-line entry point for logo discovery.
- `src/scripts/verify-supabase.ts` performs a read-only connection check.

## Prospect assets

The private `prospect-assets` bucket stores image files; PostgreSQL stores only their canonical object paths. Objects are organized by prospect UUID:

```text
prospects/{prospect_id}/logo/original.{ext}
prospects/{prospect_id}/logo/transparent.png
prospects/{prospect_id}/stitch/{filename}
```

The transparent logo must be uploaded as `image/png` with its alpha channel preserved. The bucket accepts PNG, JPEG, WebP, SVG, and GIF images up to 15 MiB. Because it is private, callers should create signed URLs when temporary external access is needed rather than persisting expiring signed URLs in the table.

The `public.prospects` table has RLS enabled, but grants no access to `anon` or `authenticated`. This is a private backend tool, so the trusted server uses a current `sb_secret_...` key. Secret keys bypass RLS and must never be used in browser code or committed to Git.

## Requirements

- Node.js 22 or newer
- A Supabase secret key for project `wleggbyvbuvwxttusrtc`

Install dependencies and create local configuration:

```bash
npm install
cp .env.example .env.local
```

Set these variables in `.env.local`:

```dotenv
SUPABASE_URL=https://wleggbyvbuvwxttusrtc.supabase.co
SUPABASE_SECRET_KEY=sb_secret_your_server_only_key
```

`.env.local` and all `.env.*` variants except `.env.example` are ignored by Git.

## Commands

```bash
npm test
npm run typecheck
npm run build
npm run db:verify
npm run prospects:import -- samples/prospects.csv
npm run logos:find -- 10
npm run logos:inspect -- 3600
```

`db:verify` builds the application, makes a read-only count query against `public.prospects`, and verifies the `prospect-assets` bucket using the server client.

## CSV prospect import

The importer requires a header row with these two named columns (additional columns are ignored):

```csv
business_name,website
Nara Pilates,https://narapilates.com
Skin Hub Med Spa,https://skinhubmedspa.com
FREEHAND,https://www.freehanddallas.com
```

Run the included sample after setting `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env.local`:

```bash
npm run prospects:import -- samples/prospects.csv
```

Each valid new row is inserted with `workflow_status = 'IMPORTED'` and `logo_status = 'PENDING'`. The importer normalizes the hostname to lowercase, removes one leading `www.`, and ignores protocol, path, port, query, fragment, and trailing-slash differences when checking the domain. The parsed, usable URL remains in `website`.

The importer checks `normalized_domain` before inserting, and the existing unique database constraint remains the final concurrency safeguard. Re-importing the same file therefore reports duplicates instead of creating additional prospects. Invalid rows and database failures are reported individually without preventing valid later rows from being processed.

Example output:

```text
CSV IMPORT COMPLETE

Total rows: 3
Imported: 3
Duplicates: 0
Failed: 0
```

## Official logo finder

The logo finder processes only prospects where both conditions are true:

```text
workflow_status = IMPORTED
logo_status = PENDING
```

Run a batch of up to 10 prospects:

```bash
npm run logos:find -- 10
```

For each prospect, the processor:

1. Sets `workflow_status = 'LOGO_SEARCHING'` and `logo_status = 'SEARCHING'`.
2. Fetches the existing prospect website with redirect, timeout, response-size, and private-network protections.
3. Inspects logo-specific evidence in header/navigation images, `<picture>` and `srcset`, SVG object assets, logo-like CSS backgrounds, structured logo metadata, footer/general images, and finally site icons.
4. Ranks candidates using semantic logo/business-name signals, header and homepage-link context, structured metadata, format, dimensions, and transparency. Known social, payment, booking-platform, badge, placeholder, and tracking assets are rejected.
5. Downloads and validates the strongest candidates using their file signatures and image metadata. It rejects corrupt, tiny, unsupported, or non-image responses.
6. Uploads the unmodified bytes to `prospect-assets/prospects/{prospect_id}/logo/original.{extension}`.
7. Downloads the private Storage object and compares its bytes with the source before marking the prospect `LOGO_FOUND` / `FOUND`.

`original_logo_url` stores the canonical private Storage object path; `logo_source_url` stores the final public asset URL on the prospect's website. This step never writes `transparent_logo_url`.

A successfully inspected site without a confident candidate becomes `LOGO_NOT_FOUND` / `NOT_FOUND`. Network, JavaScript-only rendering, unsupported asset, upload, or read-back problems become `FAILED` / `FAILED` with a useful `error_message`. One prospect failure does not stop later prospects in the batch.

The finder inspects server-returned HTML and does not execute page JavaScript. A JavaScript-only website that exposes no usable asset metadata is deliberately recorded as a technical failure rather than incorrectly labeled as having no logo.

After a live run, verify the database records:

```sql
select
  business_name,
  website,
  logo_source_url,
  original_logo_url,
  logo_status,
  workflow_status,
  error_message
from public.prospects
order by updated_at desc;
```

Because `prospect-assets` is private, generate temporary browser links for manual visual review with:

```bash
npm run logos:inspect -- 3600
```

The numeric argument is the signed-link lifetime in seconds and may be between 60 seconds and seven days. This command is read-only and uses the existing server client; it does not make the bucket public.

## Migration workflow

Never make an untracked production schema change in the Dashboard and never reset the linked remote project.

```bash
# Create the timestamped migration file first.
npx supabase migration new descriptive_change_name

# After editing and reviewing the SQL, preview and apply it.
npx supabase db push --linked --dry-run
npx supabase db push --linked

# Regenerate types after the migration is live.
npm run db:types

# Verify locally before committing.
npm test
npm run typecheck
npm run db:verify
```

The CLI must be authenticated and linked to project `wleggbyvbuvwxttusrtc` before using `--linked` commands.

## Prospect data API

```ts
import {
  createProspect,
  deleteProspect,
  getProspect,
  listProspects,
  updateProspect,
} from "./src/index.js";
```

All functions use the shared server client by default and accept an injected typed client for isolated tests.
