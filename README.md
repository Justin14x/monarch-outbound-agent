# Monarch Outbound Agent

Monarch Outbound Agent is a private TypeScript backend for processing Monarch Systems prospects. The Google lead sheet supplies the target business list and displays outreach/response statuses. Supabase stores normalized prospect identity, private visual assets, and the agent's verified evidence and retry-critical transaction state.

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

The Supabase foundation, CSV prospect importer, official-logo finder, transparent-background processing integration, Stitch request preparation, Stitch app generation/persistence, verified public-email discovery, approved-template outreach email generation, and Gmail draft creation are implemented. Approval and sending are not implemented.

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
- `src/modules/logos/transparent-logo-generator.ts` owns the official OpenAI image edit call and transparent-PNG validation.
- `src/modules/logos/transparent-logo-processor.ts` owns Step 5 eligibility, state transitions, idempotency, and Storage verification.
- `src/config/stitch-prompt.ts` is the single editable source for the master Monarch Stitch prompt.
- `src/modules/stitch/stitch-request-builder.ts` validates and prepares deterministic website/prompt/logo request payloads without calling Stitch.
- `src/lib/stitch/server.ts` owns the reusable server-only direct connection to Google's official Stitch MCP endpoint.
- `src/modules/stitch/stitch-generator.ts` owns Step 7 state transitions, retry-safe project reuse, generation, and durable screenshot persistence.
- `src/modules/emails/email-finder.ts` crawls prioritized official-site pages and ranks only explicitly published email addresses.
- `src/modules/emails/email-processor.ts` owns Step 8 eligibility, retry-safe transitions, and evidence persistence.
- `src/config/outreach-email-template.ts` contains the approved, editable Step 9 subject, body, visual sentence, and sender name.
- `src/modules/emails/outreach-email-generator.ts` renders the template and saves the email for verified prospects.
- `src/config/gmail.ts` validates server-side OAuth configuration and the sender address.
- `src/lib/gmail/server.ts` owns the official Gmail API client, offline OAuth credentials, and draft reconciliation.
- `src/modules/emails/gmail-draft-creator.ts` builds MIME drafts and owns Step 10 eligibility, persistence, and retry recovery.
- `src/lib/openai/server.ts` owns the reusable server-only OpenAI client.
- `src/scripts/import-prospects.ts` is the command-line entry point for imports.
- `src/scripts/find-logos.ts` is the command-line entry point for logo discovery.
- `src/scripts/prepare-stitch-requests.ts` is the command-line entry point for Step 6 request preparation.
- `src/scripts/generate-stitch-apps.ts` is the deliberately one-business-at-a-time Step 7 entry point.
- `src/scripts/list-stitch-mcp-tools.ts` lists the tools exposed by the live Stitch MCP server.
- `src/scripts/find-emails.ts` is the deliberately one-business-at-a-time Step 8 entry point.
- `src/scripts/generate-outreach-emails.ts` is the deliberately one-business-at-a-time Step 9 entry point.
- `src/scripts/authorize-gmail.ts` obtains a local, Git-ignored OAuth refresh token after browser consent.
- `src/scripts/create-gmail-drafts.ts` is the deliberately one-business-at-a-time Step 10 entry point.
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
- An OpenAI API key with access to `gpt-image-2.5-sunburst`
- A Google Stitch API key
- A Google Cloud project with the Gmail API enabled and a Desktop OAuth client (for Step 10)

Install dependencies and create local configuration:

```bash
npm install
cp .env.example .env.local
```

Set these variables in `.env.local`:

```dotenv
SUPABASE_URL=https://wleggbyvbuvwxttusrtc.supabase.co
SUPABASE_SECRET_KEY=sb_secret_your_server_only_key
OPENAI_API_KEY=sk_your_server_only_key
STITCH_API_KEY=your_server_only_stitch_key
GMAIL_OAUTH_CLIENT_ID=your_google_oauth_desktop_client_id
GMAIL_OAUTH_CLIENT_SECRET=your_google_oauth_desktop_client_secret
GMAIL_SENDER_EMAIL=your_gmail_address@example.com
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
npm run logos:make-transparent -- 10
npm run logos:inspect -- 3600
npm run stitch:prepare -- 10
npm run stitch:generate -- "Skin Hub Med Spa"
npm run stitch:tools
npm run emails:find -- "Skin Hub Med Spa"
npm run emails:generate -- "Skin Hub Med Spa"
npm run gmail:authorize
npm run gmail:draft -- "Skin Hub Med Spa"
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

## Transparent logo processing

Step 5 processes only records with `workflow_status = 'LOGO_FOUND'`, `logo_status = 'FOUND'`, and a non-null `original_logo_url`:

```bash
npm run logos:make-transparent -- 10
```

For every eligible record, the processor downloads the original bytes from the private `prospect-assets` bucket. If the official source asset already has usable transparency, it is preserved exactly and normalized to PNG without a paid generative edit. Otherwise, the file is supplied to the official OpenAI Image API `images.edit` method using the precision-focused `gpt-image-2.5-sunburst` model. The exact prompt is:

```text
Preserve this exact logo without altering its design, typography, colors, proportions, or spacing. Remove only the background and return the logo as a transparent PNG.
```

The API request separately sets `background = 'transparent'` and `output_format = 'png'`. The returned image must pass PNG-signature, decoding, dimensions, alpha-channel, transparent-pixel, and nonblank-content validation. It is uploaded to:

```text
prospects/{prospect_id}/logo/transparent.png
```

The uploaded object is downloaded, byte-compared, and revalidated before the record becomes `LOGO_READY` / `READY`. Original objects and source URLs are never overwritten. Prospects already marked `LOGO_READY` / `READY` are excluded, and a valid deterministic Storage output left by an interrupted run is reused without another paid OpenAI request.

After processing, compare originals and transparent versions with temporary private links:

```bash
npm run logos:inspect -- 86400
```

## Stitch request preparation

Step 6 prepares and validates the exact internal payload that Step 7 will eventually send to Google Stitch. It does not call Stitch, inspect prospect websites, or generate app screens.

The editable master prompt is defined in `src/config/stitch-prompt.ts`. Keep its `{{business_name}}` and `{{website}}` placeholders when changing the wording. It uses the business website as Stitch's reference and never claims that a logo is attached. Step 6 may record whether a validated transparent logo is available, but Step 7 currently sends no logo. Every prepared prospect transitions to `workflow_status = 'STITCH_PENDING'` with `stitch_status = 'PENDING'`.

Run a batch of up to 10 eligible prospects:

```bash
npm run stitch:prepare -- 10
```

The normal eligible paths are:

- `LOGO_READY` with a canonical `transparent_logo_url`: the private PNG is downloaded and validated for availability metadata, but the Stitch prompt remains website-only. An unavailable or unusable logo does not block preparation.
- `LOGO_NOT_FOUND` with no transparent logo: a valid no-logo request is prepared from the website and master prompt.
- `STITCH_PENDING`: rerunning deterministically refreshes the stored prompt and revalidates any referenced logo.

A prospect already marked as a technical logo-processing failure requires an explicit override to become eligible for website-only preparation:

```bash
npm run stitch:prepare -- 10 --include-logo-failures
```

The request representation contains only:

```text
business_name
website
stitch_prompt
logo_storage_path
has_logo
```

`logo_storage_path` is the canonical object path in the private `prospect-assets` bucket, never a temporary signed URL. The command creates no records or assets and is safe to rerun.

## Stitch app generation

Step 7 calls Google's official Stitch MCP endpoint directly and requires the server-only `STITCH_API_KEY` value in `.env.local`. Use `npm run stitch:tools` to discover the available live tools. The command is intentionally scoped to one exact business name so an accidental invocation cannot spend credits for every pending prospect:

```bash
npm run stitch:generate -- "Skin Hub Med Spa"
```

The command stages exactly three independent screens—Home / Discovery, Services / Booking, and Community—for one exact business. Community is a two-way concept for the business to share updates with existing customers and respond to their questions or comments, not a membership dashboard. All three screens use the same four-tab navigation: Home, Booking, Community, Account. One centralized brief in `src/config/stitch-three-screen-prompts.ts` requests all three as a unified app in exactly one `generate_screen_from_text` call with `deviceType = 'MOBILE'`.

Each staging run creates a fresh Stitch project and uploads `assets/stitch/home-medspa-reference.png` as the Home layout and **sole bottom-navigation reference**, `assets/stitch/booking-medspa-reference.png` as the Booking body-layout reference, `assets/stitch/community-medspa-reference.png` as the Community feed body-layout reference, and `assets/stitch/black-phone-presentation-reference.png` as a hardware-only reference. The Booking and Community references' navigation is explicitly excluded. The Home bar's four slots, icons, labels, size, and selected-pill geometry are locked in the prompt; only the active tab moves, using the same prospect brand color across screens. The phone reference controls the black bezel, full-device portrait framing, and Dynamic Island, not app content or branding. The prompt also asks Stitch to reuse one thin device silhouette with matching top/bottom canvas clearance on every screen. Before generation, Step 7 checks the public business website for a high-confidence official logo and explicit website color tokens. When available, it uploads the exact logo asset as a separate private Stitch image reference and passes its source URL and the verified colors into the brief. It does not read or modify Supabase logo fields, and a missing logo or palette does not block generation. The prompt tells Stitch to use a wordmark rather than a fabricated logo if it cannot use the official asset faithfully. Stitch is generative, so final branding, colors, navigation geometry, and layout still require visual review; a prompt cannot guarantee pixel-identical bars.

The three generated screen resources are captured directly from the single response's `outputComponents[].design.screens`; `list_screens` is not used to infer generation results. Staging rejects fewer or more than three resources, ambiguous Home/Booking/Community titles, duplicate or wrong-project IDs, extremely wide or overly tall canvases, and materially inconsistent canvas shapes. Each source PNG must contain a detectable phone and usable app-screen interior. A later-stage prospect requires an explicit `--replace-existing` flag.

All three source PNGs are downloaded and checked before any upload. Step 7 then extracts each app-screen interior and proportionally fits it inside the same deterministic black phone frame on a fixed **936×1804** presentation canvas. The outer phone size, bezel, corner radius, Dynamic Island, and surrounding margin no longer depend on Stitch's variable device framing. A small center crop of UI pixels may occur when source aspect ratios differ; this does **not** repair text or controls that Stitch already clipped. The original Stitch render remains available via `stitch_screenshot_url`, while `storage_path` identifies the normalized private PNG used by email. The three normalized outputs are checked for matching phone geometry, uploaded as new private objects, re-downloaded, and verified byte-for-byte. The command writes a temporary manifest containing the completed screen IDs and URLs **before** attempting Storage uploads, so an upload failure does not require another generation attempt. Staging never changes `app_image_urls`, workflow status, or Gmail. Each object uses:

```text
prospects/{prospect_id}/stitch/{screen_id}.png
```

Review all three screenshots for visual consistency and unsupported factual claims before committing the manifest. If acceptable, commit only the same business with:

```bash
npm run stitch:generate -- "Business Name" --commit /path/to/manifest.json
```

Commit re-verifies all three private PNGs and atomically replaces that prospect's ordered `app_image_urls` only if its `updated_at` value has not changed since staging. It also records the unified prompt and keeps any later outreach/Gmail workflow status untouched. A failed generation or upload leaves the prior `app_image_urls` intact. The command does not send or modify Gmail drafts.

For isolated text-only or image-reference trials that do not touch the production Stitch workflow, use [the Stitch prompt experiment notebook](experiments/stitch-prompts/README.md).

## Locked Home showcase pilot

The separate `showcase:home` pilot tests a deterministic alternative to re-editing the reference image with Stitch for every business. It builds the phone, Home layout, four-tab navigation, and image/text slots from HTML/CSS, then renders an 851×1847 PNG in pinned headless Chromium. It never calls Stitch, Supabase, or Gmail. It does **not** replace production Step 7 or update any prospect.

The included Skin Hub configuration is `examples/showcase/skin-hub-home.json`. It names the business, concise text, brand accent, and local assets, with a public source URL recorded for each image. The logo and photographs were downloaded from the business website for this private concept pilot. The renderer reads local files only; it does not crawl a website or invent a missing logo. Install Playwright's pinned headless Chromium once on a new machine:

```bash
npx playwright-core install --only-shell chromium
```

```bash
npm run showcase:home
```

The preview is written to `output/showcase/skin-hub-home.png`. To try another manually prepared business without changing the layout:

```bash
npm run showcase:home -- examples/showcase/another-business.json output/showcase/another-business-home.png
```

Keep asset files inside `assets/` and list their paths relative to that directory in the configuration. The renderer requires all images to load, checks the fixed text slots and key section boundaries for overflow, and refuses incomplete/invalid input. The bottom navigation markup and geometry are shared rather than generated anew. Website-sourced imagery is not automatically evidence of ownership or usage rights; review assets and claims before external use.

This is a **Home-only pilot** for visual approval. Booking and Community screens, a broader cross-business pilot, and any approval/Storage/Gmail integration are separate follow-up work. Until those are reviewed, continue to treat the existing Stitch-to-Supabase workflow as the live path.

## Verified public-email discovery

Step 8 is intentionally scoped to one exact business per command while initial results are reviewed:

```bash
npm run emails:find -- "Skin Hub Med Spa"
```

The finder visits the supplied official website first and follows same-site Contact, About, Team, Leadership, and Locations links. It accepts only addresses explicitly present in page content or `mailto:` links and never constructs or infers an address. Candidates are ranked in this order: owner/founder/decision-maker, management/business, then general business contact.

Every accepted result stores `contact_email`, any explicitly associated `contact_name`, the exact public `email_source_url`, and `email_verified = true`, then transitions to `EMAIL_FOUND`. A completed search with no published address clears the contact evidence and transitions to `EMAIL_NOT_FOUND`. Technical failures remain distinct, increment `retry_count`, and do not masquerade as a not-found result.

An optional public-source search adapter is available for cases where the official site has no email. No paid sales-intelligence service or guessing mechanism is built in. Explicit retries of `EMAIL_NOT_FOUND` are supported; already verified prospects are excluded by the Supabase query.

## Outreach email generation

The approved sales wording and sender name live in `src/config/outreach-email-template.ts`. Edit that one file to change the email copy. Generation uses deterministic placeholder substitution; it does not call an AI model.

```bash
npm run emails:generate -- "Skin Hub Med Spa"
```

Only an exact business match with `workflow_status = 'EMAIL_FOUND'` and `email_verified = true` is selected. The renderer also requires the verified contact email and its public source URL. It uses the contact name when one is recorded; otherwise it greets the business team. The optional visual sentence is included only when `app_image_urls` contains a stored Stitch screen PNG for that prospect.

One guarded database update saves `email_subject` and `email_body` and sets `workflow_status = 'EMAIL_GENERATED'`. A rerun excludes that completed prospect. This command does not create a Gmail draft or send an email.

## Gmail draft creation (Step 10)

This step uses Google's official Gmail API and an OAuth **Desktop app** client. Draft creation calls only draft methods; there is no send operation or sending command. The requested `gmail.compose` scope permits both managing drafts and sending at Google's permission level; sending is prohibited by this application's draft-only gateway. Keep the OAuth client secret and local refresh token on the server only. Authorization uses a loopback callback, random state, and PKCE.

One-time Google setup:

1. In [Google Cloud Console](https://console.cloud.google.com/), select or create the project that will own this integration and **enable the Gmail API**.
2. Under **Google Auth platform**, configure **Branding** and **Audience**. Use **Internal** if the Gmail account belongs to your Google Workspace organization; otherwise use **External**, keep it in testing for this private setup, and add the Gmail account you will authorize as a **test user**. Under **Data Access**, add the scopes `https://www.googleapis.com/auth/gmail.compose`, `https://www.googleapis.com/auth/gmail.metadata`, and `https://www.googleapis.com/auth/spreadsheets` if prompted. Enable the Google Sheets API in the same Cloud project for lead-sheet synchronization.
3. Under **Google Auth platform → Clients**, create an OAuth client with application type **Desktop app**. Copy its client ID and client secret into `GMAIL_OAUTH_CLIENT_ID` and `GMAIL_OAUTH_CLIENT_SECRET` in `.env.local`. Set `GMAIL_SENDER_EMAIL` to the Gmail account being authorized. The server verifies the OAuth mailbox matches this address; send-as aliases are not supported by this check.
4. Share the lead Sheet with that Gmail account as an Editor. Run `npm run gmail:authorize` on this computer. Keep the process running and open the newly printed URL within 30 minutes, sign into that Gmail account, and grant consent. The listener starts before the URL is printed; `http://127.0.0.1:8765/health` confirms it is listening. The local callback is `http://127.0.0.1:8765/oauth2callback`. Before replacing `.gmail-oauth-token.json`, authorization verifies the authenticated Gmail address and its access to the lead Sheet. If either check fails, the prior token remains untouched. The token is stored in the repository root with owner-only permissions and is Git-ignored. If the process timed out or stopped, restart it and use the new link, not an old callback URL. Do not paste token contents into chat or commit them.

The current authorized mailbox is `justin@getmonarchsystems.com`. Reauthorization alone does not transfer drafts between Gmail accounts. Skin Hub's draft was copied separately into this mailbox with `npm run gmail:copy-draft -- "Skin Hub Med Spa"`, using its saved copy and three private app images. This command verifies the new message remains a draft with all inline images before replacing the prospect's stored draft ID. It is retry-safe for that prospect and never sends. The original draft remains untouched in `contact.monarchsystems@gmail.com`; the `Test Leads` tab records the new draft ID and retains the previous ID in its cell note. No email is sent during authorization or copying.

After authorization, create **only Skin Hub's** draft with:

```bash
npm run gmail:draft -- "Skin Hub Med Spa"
```

The command selects only an exact business-name match with `workflow_status = 'EMAIL_GENERATED'` and `email_verified = true`. It uses the saved recipient, subject, and body. Each draft carries a `X-Monarch-Prospect-ID` header. Before creating anything, it checks the stored draft ID or scans existing drafts for that header, recovering a prior draft if an earlier run stopped before the database update. It persists `gmail_draft_id` first, verifies the Gmail draft exists, then sets `workflow_status = 'DRAFT_CREATED'`. A completed prospect is excluded on rerun; it never sends.

Real local commands acquire an exclusive `.gmail-draft.lock` before reading candidates. Overlapping commands are refused. Draft creation disables automatic HTTP retries; an uncertain result is reconciled with Gmail on the next run instead of blindly re-posted. A crashed process intentionally leaves the lock behind: confirm no run is active and inspect existing Gmail drafts before manually removing this one lock file. This is single-host CLI protection, not distributed exactly-once execution; do not run independent copies against the same mailbox concurrently.

Open [Gmail Drafts](https://mail.google.com/mail/u/0/#drafts) in the authorized account to review the draft. If Google OAuth is configured as **External / Testing**, Google may expire the refresh token after seven days; rerun `npm run gmail:authorize` if authorization expires. Never run the draft command for other businesses until their generated emails are ready for review.

### Step 11: app concept inside Gmail drafts

Future outreach copy is edited in `src/config/outreach-email-template.ts`. The text introduces Justin as founder, identifies the prospect by business name and website, explains the app concept and potential value, and invites a conversation. It does not assert prospect-specific facts that were not stored. The draft builder converts the stored `email_body` into both plain-text and HTML MIME alternatives. If `app_image_urls` contains PNGs in this prospect's own `prospects/{id}/stitch/` Storage folder, the server selects up to three distinct screen resources (Home first), downloads each privately, and attaches each with its own `Content-ID`. Two or three independent screens render in an equal-width, top-aligned presentation table capped at 600 px. A single screen remains a single inline image; the renderer does not split or invent additional screens. The private Storage objects stay private; no public or signed image URL is placed in the email. If no image metadata is present, the draft remains a readable text/HTML email without an image. If a referenced image cannot be downloaded or is invalid, draft creation fails without creating a partial draft.

After creating or updating an image-bearing draft, the Gmail gateway reads it back and verifies the stored message still has a `multipart/related` root, HTML `cid:` references, and inline PNG parts with matching Content-IDs. Gmail's web draft editor may later re-save the message as `multipart/mixed` with ordinary attachments; the compose preview alone does not prove recipient rendering. Refresh the draft with `gmail:enhance` before relying on it. A future sending step should rebuild and verify the canonical MIME immediately before sending, then pass that raw MIME to Gmail's draft-send API. The production agent does not currently send email.

The Step 10 draft command still selects only `EMAIL_GENERATED` rows and never modifies an existing `DRAFT_CREATED` draft. A separate, **explicit** command is available to replace one existing draft after approval:

```bash
npm run gmail:enhance -- "Skin Hub Med Spa"
```

It requires the exact business name, an existing verified `DRAFT_CREATED` prospect and a matching Gmail draft, plus a stored Stitch PNG. It replaces that draft under the same draft ID using the updated centralized template, then saves the new subject/body back to Supabase. This overwrites any manual edits made to that draft; inspect the existing draft and approve the replacement before running it. It calls Gmail's draft update method only, with automatic HTTP retries disabled. There is still no Gmail send operation or automatic sending path.

## Med-spa lead sheet synchronization

The existing [Lead_List spreadsheet](https://docs.google.com/spreadsheets/d/1ohJFtP__Dy2YrpXV-tMEi9BMia-l1VOGYlIFSsvUcso/edit?gid=964068620#gid=964068620), `Leads` tab, is the production outreach dashboard. Its sheet ID, tab name, and exact A:E headers are centralized in `src/config/lead-sheet.ts`. Column D accepts `Not Sent`/`Sent`; column E accepts `No Response`/`Responded`. Existing conditional formatting supplies red/green colors. The sheet is matched to prospects by normalized website domain in column C. Ambiguous duplicate domains are skipped rather than updating an arbitrary row.

The separate `Test Leads` tab holds Skin Hub's existing test outreach record, including its current Gmail draft ID and copy. It is deliberately excluded from `leads:import` and `leads:sync`, which target only `Leads`. A draft is not a sent email: Skin Hub remains `Not Sent` / `No Response`. Do not move it into the production tab or send it as part of a batch test.

The sheet supplies new prospects using the existing idempotent CSV-import logic. Only business name and website are imported. The sheet's business-email column is not treated as verified without a public source URL. The 50 production rows were imported on October 13, 2026 (50 imported, 0 duplicates, 0 failures); reruns skip existing normalized domains:

```bash
npm run leads:import
```

The sync command is safe to rerun. It changes D to `Sent` only when a prospect is `SENT` in Supabase and has both `sent_at` and a Gmail sent-message ID. It checks that message's Gmail thread using headers only, reads the actual single recipient from the confirmed SENT message, and changes E to `Responded` only after an incoming message from that exact address is found. Column E is the operational response indicator; the reply ID and timestamp are not written to Supabase by this command. It never downgrades a green status, marks a draft as sent, creates a draft, or sends an email. Changes are read back from the sheet for verification. Run it manually with:

```bash
npm run leads:sync
```

The Gmail metadata and Sheets OAuth scopes are authorized and the Sheets API is enabled in Google Cloud project `146222353212`. A live `leads:sync` completed successfully with no status changes. Both commands are currently manual; there is no background watcher or scheduled job. A future send implementation must persist Gmail's sent message ID and `sent_at` in Supabase after a confirmed send; only then can this command mark that prospect `Sent`. No existing draft is sent by this integration.

### Data ownership

The production `Leads` tab owns the target business list (A/C), an unverified lead-email reference (B), and the human-facing sent/response indicators (D/E). Supabase owns normalized business identity, private logo/mockup assets, Stitch identifiers, publicly verified contact evidence, generated copy, and Gmail draft/send IDs and timestamps needed for reliable retries and reconciliation. Gmail owns the actual drafts and messages. The `Test Leads` tab is a safety copy of Skin Hub's in-flight draft, not a production source or send list.

This intentionally keeps agent transaction state in Supabase instead of copying it into extra production-sheet columns. In particular, a red/green sheet cell is not proof of Gmail delivery, and a draft ID must survive retries even if the sheet is edited. The `move_reply_status_to_sheet` migration removed only the three unused reply-tracking columns after verifying that no reply was recorded; the response indicator now lives solely in sheet column E. Do not drop the remaining populated `prospects` columns without first replacing the corresponding idempotency and verification logic.

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
