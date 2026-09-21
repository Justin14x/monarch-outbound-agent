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

The Supabase foundation and CSV prospect importer are implemented. Logo discovery/processing, Stitch, email discovery, email generation, and Gmail are intentionally not implemented.

## Architecture

- `supabase/migrations/` is the authoritative, replayable database history.
- `src/types/database.generated.ts` is generated from the live Supabase schema.
- `src/lib/supabase/server.ts` owns the application's single reusable server-side client.
- `src/modules/prospects/` owns prospect types and CRUD operations.
- `src/modules/prospects/prospect.csv-import.ts` owns CSV validation, deduplication, and row-level import results.
- `src/modules/prospects/website-normalization.ts` owns website parsing and normalized-domain generation.
- `src/scripts/import-prospects.ts` is the command-line entry point for imports.
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
