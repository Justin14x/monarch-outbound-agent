import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import {
  buildGmailDraftRaw,
  combineEmailScreenshots,
  createGmailDrafts,
  findConceptImagePath,
  findConceptImagePaths,
  monarchSignatureLogoUrl,
  optimizeEmailScreenshot,
  type GmailDraftStore,
} from "../src/modules/emails/gmail-draft-creator.js";
import type {
  GmailDraftGateway,
  GmailDraftRecord,
} from "../src/lib/gmail/server.js";
import type { Prospect } from "../src/modules/prospects/prospect.types.js";

const ID = "b93a9f95-17cd-4d2f-a803-7b7c0635253f";
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function decodedPart(mime: string, type: string): string {
  const marker = `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
  const data = mime.split(marker)[1]?.split("\r\n--monarch-alt-")[0]?.replaceAll("\r\n", "");
  return Buffer.from(data ?? "", "base64").toString("utf8");
}

function inlineContentIds(mime: string): string[] {
  return [...mime.matchAll(/^Content-ID: <([^<>\r\n]+)>\r?$/gm)].map((match) => match[1]!);
}

function prospect(overrides: Partial<Prospect> = {}): Prospect {
  return {
    app_image_urls: null,
    business_name: "Skin Hub Med Spa",
    contact_email: "services@skinhubmedspa.com",
    contact_name: null,
    created_at: "2026-09-21T00:00:00.000Z",
    email_body: "Hi Skin Hub team,\n\nA mobile app idea for you.\n\nBest,\nJustin",
    email_source_url: "https://skinhubmedspa.com/contact",
    email_subject: "A mobile app idea for Skin Hub Med Spa",
    email_verified: true,
    error_message: null,
    gmail_draft_id: null,
    gmail_message_id: null,
    id: ID,
    logo_source_url: null,
    logo_status: "PENDING",
    normalized_domain: "skinhubmedspa.com",
    original_logo_url: null,
    retry_count: 0,
    sent_at: null,
    stitch_project_id: null,
    stitch_attempt: null,
    stitch_prompt: null,
    stitch_status: null,
    transparent_logo_url: null,
    updated_at: "2026-09-21T00:00:00.000Z",
    website: "https://skinhubmedspa.com",
    workflow_status: "EMAIL_GENERATED",
    ...overrides,
  };
}

function memoryStore(initial = prospect()) {
  let current = initial;
  const listCandidates = vi.fn(async ({ businessName }) =>
    current.business_name === businessName &&
    current.workflow_status === "EMAIL_GENERATED" &&
    current.email_verified
      ? [current]
      : [],
  );
  const saveDraftId = vi.fn(async (_id: string, draftId: string) => {
    current = { ...current, gmail_draft_id: draftId };
  });
  const markDraftCreated = vi.fn(async () => {
    current = { ...current, workflow_status: "DRAFT_CREATED" };
  });
  return {
    store: { listCandidates, saveDraftId, markDraftCreated } as GmailDraftStore,
    current: () => current,
    listCandidates,
    saveDraftId,
    markDraftCreated,
  };
}

function gateway(existing: GmailDraftRecord | null = null) {
  let draft = existing;
  const createDraft = vi.fn(async (_raw: string) => {
    draft = { id: "draft-new", prospectId: ID };
    return draft.id;
  });
  const findDraftByProspectId = vi.fn(async (prospectId: string) =>
    draft?.prospectId === prospectId ? draft : null,
  );
  const getDraft = vi.fn(async (id: string) => (draft?.id === id ? draft : null));
  const updateDraft = vi.fn(async (id: string, _raw: string) => id);
  return {
    gateway: { createDraft, findDraftByProspectId, getDraft, updateDraft } as GmailDraftGateway,
    createDraft,
    findDraftByProspectId,
    getDraft,
  };
}

describe("Gmail draft MIME", () => {
  it("encodes the verified recipient, subject, body and stable prospect marker", () => {
    const raw = buildGmailDraftRaw(prospect(), "justin@example.com");
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("From: Justin Olaleye <justin@example.com>\r\n");
    expect(mime).toContain("To: services@skinhubmedspa.com\r\n");
    expect(mime).toContain("Subject: A mobile app idea for Skin Hub Med Spa\r\n");
    expect(mime).toContain(`X-Monarch-Prospect-ID: ${ID}\r\n`);
    expect(mime).toContain("Content-Type: multipart/alternative;");
    expect(decodedPart(mime, "text/plain")).toBe(
      prospect().email_body?.replace(/\n/g, "\r\n"),
    );
    expect(decodedPart(mime, "text/html")).toContain("A mobile app idea for you.");
    expect(mime).not.toContain("Content-ID:");
  });

  it("embeds a private PNG as an inline CID image in multipart related HTML", () => {
    const item = prospect({ email_body: "Hi team,\n\nHere’s a preview of the app concept:\n\nDiscuss?" });
    const mime = Buffer.from(buildGmailDraftRaw(item, "justin@example.com", PNG), "base64url").toString("utf8");
    const [cid] = inlineContentIds(mime);
    expect(cid).toMatch(new RegExp(`^app-concept-${ID}-[a-f0-9]{32}@monarch\\.local$`));
    expect(mime).toContain('Content-Type: multipart/related; type="multipart/alternative";');
    expect(mime).toContain(`Content-ID: <${cid}>`);
    expect(mime).toContain("Content-Disposition: inline;");
    expect(decodedPart(mime, "text/html")).toContain(`src="cid:${cid}"`);
    expect(decodedPart(mime, "text/plain")).not.toContain("cid:");
    expect(mime).not.toContain("supabase.co");
    const imageBase64 = mime.split(`Content-ID: <${cid}>\r\n\r\n`)[1]?.split("\r\n--monarch-related-")[0]?.replaceAll("\r\n", "");
    expect(Buffer.from(imageBase64 ?? "", "base64")).toEqual(PNG);
  });

  it("combines three optimized screenshots into one proportional showcase with one CID", async () => {
    const png = await sharp({ create: { width: 936, height: 1804, channels: 3, background: "#f2e9de" } }).png().toBuffer();
    const jpeg = await optimizeEmailScreenshot(png);
    const metadata = await sharp(jpeg).metadata();
    expect(metadata).toMatchObject({ format: "jpeg", width: 564 });
    expect(metadata.height).toBeGreaterThan(1000);
    const combined = await combineEmailScreenshots([jpeg, jpeg, jpeg]);
    expect(await sharp(combined).metadata()).toMatchObject({ format: "jpeg", width: 1800 });
    const mime = Buffer.from(buildGmailDraftRaw(prospect(), "justin@example.com", combined), "base64url").toString("utf8");
    const ids = inlineContentIds(mime);
    expect(ids).toHaveLength(1);
    expect(mime.match(/Content-Type: image\/jpeg/g)).toHaveLength(1);
    expect(mime).toContain('filename="app-screen-1.jpg"');
    for (const id of ids) expect(decodedPart(mime, "text/html")).toContain(`src="cid:${id}"`);
    expect(decodedPart(mime, "text/html")).toContain('alt="Skin Hub Med Spa Home, Booking, and Community app concepts"');
  });

  it("preserves Home, Booking, Community order and top alignment in the composite", async () => {
    const colors = ["#ff0000", "#00ff00", "#0000ff"];
    const sources = await Promise.all(colors.map((color, index) =>
      sharp({ create: { width: 600, height: 1000 + index * 100, channels: 3, background: color } })
        .png().toBuffer(),
    ));
    const composite = await combineEmailScreenshots(sources);
    const { data, info } = await sharp(composite).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(1800);
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    expect(pixel(320, 100)[0]).toBeGreaterThan(200);
    expect(pixel(900, 100)[1]).toBeGreaterThan(200);
    expect(pixel(1480, 100)[2]).toBeGreaterThan(200);
  });

  it("renders the combined showcase at a bounded width without a second image role", () => {
    const mime = Buffer.from(buildGmailDraftRaw(prospect(), "justin@example.com", PNG), "base64url").toString("utf8");
    const html = decodedPart(mime, "text/html");
    expect(html).toContain('<table role="presentation" align="center" width="100%"');
    expect(html).toContain('max-width:600px;margin:0 auto');
    expect(html).toContain('width="600"');
    expect(html).toContain('height:auto');
    const contentIds = inlineContentIds(mime);
    expect(contentIds).toHaveLength(1);
    expect(contentIds[0]).toMatch(new RegExp(`^app-concept-${ID}-[a-f0-9]{32}@monarch\\.local$`));
    expect(html).toContain(`src="cid:${contentIds[0]}"`);
    expect(decodedPart(mime, "text/plain")).toBe(prospect().email_body?.replaceAll("\n", "\r\n"));
    expect(mime).not.toContain("supabase.co");
  });

  it("replaces the screenshot placeholder at its exact position without exposing it to recipients", () => {
    const body = `Hi Skin Hub Med Spa team,\n\nClients could easily book their next treatment.\n\n[Insert three personalized app screenshots]\n\nWould you like a quick rundown?`;
    const item = prospect({ email_body: body });
    const mime = Buffer.from(buildGmailDraftRaw(item, "justin@example.com", PNG), "base64url").toString("utf8");
    const html = decodedPart(mime, "text/html");
    const plain = decodedPart(mime, "text/plain");
    expect(html).not.toContain("[Insert three personalized app screenshots]");
    expect(plain).not.toContain("[Insert three personalized app screenshots]");
    expect(plain).toContain("Three personalized app screenshots are included in the HTML version of this email.");
    expect(html.indexOf("Clients could easily book")).toBeLessThan(html.indexOf('<table role="presentation"'));
    expect(html.indexOf('<table role="presentation"')).toBeLessThan(html.indexOf("Would you like a quick rundown?"));
    expect((html.match(/src="cid:/g) ?? [])).toHaveLength(1);
    expect(() => buildGmailDraftRaw(item, "justin@example.com")).toThrow("one combined");
  });

  it("renders the outreach message as ordinary text in HTML and plain text", () => {
    const item = prospect({
      email_body: "Hi Skin Hub team,\n\nAn industry report found that 73% of med spa patients are repeat customers. A branded mobile app can help encourage those repeat visits.\n\n[Insert three personalized app screenshots]\n\nBest,\nJustin\nMonarch Systems",
    });
    const mime = Buffer.from(buildGmailDraftRaw(item, "justin@example.com", PNG), "base64url").toString("utf8");
    const html = decodedPart(mime, "text/html");
    const plain = decodedPart(mime, "text/plain");
    expect(html).toContain("A branded mobile app can help encourage those repeat visits.</p>");
    expect(html).not.toContain("<strong>");
    expect(plain).toContain("A branded mobile app can help encourage those repeat visits.");
    expect(plain).not.toContain("<strong>");
    expect(inlineContentIds(mime)).toHaveLength(1);
  });

  it("links only the Monarch Systems signature in HTML without a redundant plain-text URL", () => {
    const item = prospect({
      email_body: "Hi team,\n\nI work with Monarch Systems.\n\nBest,\nJustin\nMonarch Systems\n\n505 Boyett St #A, College Station, TX 77840",
    });
    const mime = Buffer.from(buildGmailDraftRaw(item, "justin@example.com", PNG), "base64url").toString("utf8");
    const html = decodedPart(mime, "text/html");
    const plain = decodedPart(mime, "text/plain");
    expect(html).toContain('I work with Monarch Systems.');
    expect(html).toContain('Best,<br>Justin<br><img src="https://raw.githubusercontent.com/Justin14x/monarch-outbound-agent/');
    expect(html).toContain('&nbsp;<a href="https://www.monarchsystems.app/">Monarch Systems</a>');
    expect((html.match(/href="https:\/\/www\.monarchsystems\.app\/"/g) ?? [])).toHaveLength(1);
    expect((html.match(/src="cid:/g) ?? [])).toHaveLength(1);
    expect(plain).toContain("Best,\r\nJustin\r\nMonarch Systems");
    expect(plain).toContain("505 Boyett St #A, College Station, TX 77840");
    expect(html).toContain("505 Boyett St #A, College Station, TX 77840");
    expect(html).not.toContain("A business proposal from Monarch Systems.");
    expect(html).toContain("505 Boyett St #A, College Station, TX 77840");
    expect(plain).not.toContain("https://");
  });

  it("uses a separately hosted Monarch logo without introducing a second CID image", () => {
    const item = prospect({
      email_body: "Hi team,\n\n[Insert three personalized app screenshots]\n\nBest,\nJustin\nMonarch Systems",
    });
    const logoUrl = "https://www.monarchsystems.app/assets/logo.png";
    const mime = Buffer.from(buildGmailDraftRaw(item, "justin@example.com", PNG, logoUrl), "base64url").toString("utf8");
    const html = decodedPart(mime, "text/html");
    const orderedMimeIds = inlineContentIds(mime);
    expect(orderedMimeIds).toHaveLength(1);
    expect(orderedMimeIds[0]).toMatch(/^app-concept-/);
    expect(html).toContain(`<img src="${logoUrl}" alt="" width="24" height="24"`);
    expect(html).toContain(`&nbsp;<a href="https://www.monarchsystems.app/">Monarch Systems</a>`);
    expect(html.indexOf(logoUrl)).toBeLessThan(html.indexOf('href="https://www.monarchsystems.app/"'));
    expect(monarchSignatureLogoUrl({ MONARCH_SIGNATURE_LOGO_URL: logoUrl })).toBe(logoUrl);
    expect(monarchSignatureLogoUrl({})).toContain("raw.githubusercontent.com/Justin14x/monarch-outbound-agent/");
    expect(() => monarchSignatureLogoUrl({ MONARCH_SIGNATURE_LOGO_URL: "http://example.com/logo.png" })).toThrow("stable HTTPS");
    expect(() => buildGmailDraftRaw(item, "justin@example.com", PNG, "https://example.com/logo.png")).toThrow("stable HTTPS");
  });

  it("never stretches the combined showcase height", () => {
    const mime = Buffer.from(buildGmailDraftRaw(prospect(), "justin@example.com", PNG), "base64url").toString("utf8");
    const html = decodedPart(mime, "text/html");
    expect(html).toContain('height:auto');
    expect(html).not.toMatch(/height="\d+"/);
  });

  it("uses fresh globally unique content IDs for each MIME message", () => {
    const first = Buffer.from(buildGmailDraftRaw(prospect(), "justin@example.com", PNG), "base64url").toString("utf8");
    const second = Buffer.from(buildGmailDraftRaw(prospect(), "justin@example.com", PNG), "base64url").toString("utf8");
    const firstIds = inlineContentIds(first);
    const secondIds = inlineContentIds(second);
    expect(new Set(firstIds).size).toBe(1);
    expect(new Set(secondIds).size).toBe(1);
    expect(firstIds).not.toEqual(secondIds);
    expect(decodedPart(first, "text/html")).toContain(`src="cid:${firstIds[0]}"`);
    expect(decodedPart(second, "text/html")).toContain(`src="cid:${secondIds[0]}"`);
  });

  it("escapes prospect-controlled text in HTML and rejects non-PNG bytes", () => {
    const item = prospect({ email_body: "Hi <script>alert('x')</script> & team" });
    const mime = Buffer.from(buildGmailDraftRaw(item, "justin@example.com"), "base64url").toString("utf8");
    expect(decodedPart(mime, "text/html")).toContain("&lt;script&gt;");
    expect(decodedPart(mime, "text/html")).not.toContain("<script>");
    expect(() => buildGmailDraftRaw(item, "justin@example.com", Buffer.from("not a png"))).toThrow("valid PNG");
  });

  it("uses only the prospect's own stored Stitch PNG, preferring Home", () => {
    const item = prospect({ app_image_urls: [
      { screen_id: "booking", screen_name: "Booking", storage_path: `prospects/${ID}/stitch/booking.png` },
      { screen_id: "home", screen_name: "Home", storage_path: `prospects/${ID}/stitch/home.png` },
      { screen_id: "other", screen_name: "Other", storage_path: "prospects/other/stitch/other.png" },
    ] });
    expect(findConceptImagePath(item)).toBe(`prospects/${ID}/stitch/home.png`);
    expect(findConceptImagePaths(item)).toEqual([
      `prospects/${ID}/stitch/home.png`,
      `prospects/${ID}/stitch/booking.png`,
    ]);
    expect(findConceptImagePath(prospect({ app_image_urls: null }))).toBeNull();
    expect(findConceptImagePath(prospect({ app_image_urls: [{ storage_path: "https://example.com/image.png" }] }))).toBeNull();
  });

  it("deduplicates and caps the showcase at three stored screens", async () => {
    const paths = ["home", "booking", "community", "profile"].map((name) => ({
      screen_id: name, screen_name: name, storage_path: `prospects/${ID}/stitch/${name}.png`,
    }));
    expect(findConceptImagePaths(prospect({ app_image_urls: [...paths, paths[0]!] }))).toEqual(
      paths.slice(0, 3).map((item) => item.storage_path),
    );
    await expect(combineEmailScreenshots([PNG, PNG])).rejects.toThrow("exactly three");
  });

  it("refuses unverified, incomplete or header-injected messages", () => {
    expect(() => buildGmailDraftRaw(prospect({ email_verified: false }), "justin@example.com")).toThrow();
    expect(() => buildGmailDraftRaw(prospect({ contact_email: null }), "justin@example.com")).toThrow();
    expect(() => buildGmailDraftRaw(prospect({ contact_email: "elitemedspa3319@gmail.com214.241.4475" }), "justin@example.com")).toThrow("valid sender and verified recipient");
    expect(() => buildGmailDraftRaw(prospect({ email_subject: null }), "justin@example.com")).toThrow();
    expect(() => buildGmailDraftRaw(prospect({ email_body: null }), "justin@example.com")).toThrow();
    expect(() => buildGmailDraftRaw(prospect({ email_subject: "Hello\r\nBcc: x@y.com" }), "justin@example.com")).toThrow();
  });
});

describe("Gmail draft creation and recovery", () => {
  const options = { businessName: "Skin Hub Med Spa", senderEmail: "justin@example.com" };

  it("creates one draft and excludes the completed prospect on rerun", async () => {
    const memory = memoryStore();
    const gmail = gateway();
    const first = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway });
    const second = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway });
    expect(first).toMatchObject({ created: 1, recovered: 0, failed: 0, processed: 1 });
    expect(second).toMatchObject({ created: 0, recovered: 0, failed: 0, processed: 0 });
    expect(memory.current()).toMatchObject({ gmail_draft_id: "draft-new", workflow_status: "DRAFT_CREATED" });
    expect(gmail.createDraft).toHaveBeenCalledTimes(1);
    expect(memory.saveDraftId).toHaveBeenCalledTimes(1);
    expect(memory.markDraftCreated).toHaveBeenCalledTimes(1);
  });

  it("downloads the stored screenshot and creates exactly one inline-image draft", async () => {
    const path = `prospects/${ID}/stitch/home.png`;
    const memory = memoryStore(prospect({ app_image_urls: [{ screen_id: "home", screen_name: "Home", storage_path: path }] }));
    const gmail = gateway();
    const downloadPng = vi.fn(async (_path: string) => PNG);
    const first = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway, imageStore: { downloadEmailImage: downloadPng } });
    const second = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway, imageStore: { downloadEmailImage: downloadPng } });
    expect(first).toMatchObject({ created: 1, failed: 0 });
    expect(second.processed).toBe(0);
    expect(downloadPng).toHaveBeenCalledExactlyOnceWith(path);
    expect(gmail.createDraft).toHaveBeenCalledTimes(1);
    const mime = Buffer.from(gmail.createDraft.mock.calls[0]?.[0] ?? "", "base64url").toString("utf8");
    expect(inlineContentIds(mime)[0]).toMatch(new RegExp(`^app-concept-${ID}-[a-f0-9]{32}@monarch\\.local$`));
  });

  it("downloads all selected private screens before creating one draft", async () => {
    const paths = ["home", "booking", "community"].map((name) => `prospects/${ID}/stitch/${name}.png`);
    const memory = memoryStore(prospect({ app_image_urls: paths.map((path, index) => ({
      screen_id: String(index), screen_name: ["Home", "Booking", "Community"][index], storage_path: path,
    })) }));
    const gmail = gateway();
    const validPng = await sharp({ create: { width: 600, height: 1100, channels: 3, background: "#f2e9de" } }).png().toBuffer();
    const downloadPng = vi.fn(async (_path: string) => validPng);
    const result = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway, imageStore: { downloadEmailImage: downloadPng } });
    expect(result.created).toBe(1);
    expect(downloadPng.mock.calls.map((call) => call[0])).toEqual(paths);
    expect(gmail.createDraft).toHaveBeenCalledTimes(1);
    const mime = Buffer.from(gmail.createDraft.mock.calls[0]?.[0] ?? "", "base64url").toString("utf8");
    expect((mime.match(/Content-ID: </g) ?? [])).toHaveLength(1);
  });

  it("creates a text and HTML draft without an image when app_image_urls is missing", async () => {
    const memory = memoryStore(prospect({ app_image_urls: null }));
    const gmail = gateway();
    const downloadPng = vi.fn(async () => PNG);
    const result = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway, imageStore: { downloadEmailImage: downloadPng } });
    expect(result.created).toBe(1);
    expect(downloadPng).not.toHaveBeenCalled();
    const mime = Buffer.from(gmail.createDraft.mock.calls[0]?.[0] ?? "", "base64url").toString("utf8");
    expect(mime).toContain("Content-Type: text/html;");
    expect(mime).not.toContain("Content-ID:");
  });

  it("does not create a draft or advance status when private image download fails", async () => {
    const memory = memoryStore(prospect({ app_image_urls: [{ screen_id: "home", storage_path: `prospects/${ID}/stitch/home.png` }] }));
    const gmail = gateway();
    const result = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway,
      imageStore: { downloadEmailImage: async () => { throw new Error("Storage unavailable"); } },
    });
    expect(result).toMatchObject({ failed: 1, created: 0 });
    expect(gmail.createDraft).not.toHaveBeenCalled();
    expect(memory.current().workflow_status).toBe("EMAIL_GENERATED");
  });

  it("recovers an existing Gmail draft after an interrupted database write", async () => {
    const memory = memoryStore();
    const gmail = gateway();
    memory.saveDraftId.mockRejectedValueOnce(new Error("Supabase unavailable"));
    const first = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway });
    const second = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway });
    expect(first).toMatchObject({ created: 0, failed: 1 });
    expect(second).toMatchObject({ created: 0, recovered: 1, failed: 0 });
    expect(gmail.createDraft).toHaveBeenCalledTimes(1);
    expect(memory.current().workflow_status).toBe("DRAFT_CREATED");
  });

  it("recovers a stored draft ID without creating another", async () => {
    const memory = memoryStore(prospect({ gmail_draft_id: "draft-existing" }));
    const gmail = gateway({ id: "draft-existing", prospectId: ID });
    const result = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway });
    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(gmail.findDraftByProspectId).not.toHaveBeenCalled();
    expect(gmail.createDraft).not.toHaveBeenCalled();
    expect(memory.saveDraftId).not.toHaveBeenCalled();
  });

  it("fails closed if a stored draft is missing or belongs to another prospect", async () => {
    const memory = memoryStore(prospect({ gmail_draft_id: "draft-existing" }));
    const gmail = gateway({ id: "draft-existing", prospectId: "someone-else" });
    const result = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway });
    expect(result).toMatchObject({ failed: 1, created: 0 });
    expect(gmail.createDraft).not.toHaveBeenCalled();
    expect(memory.current().workflow_status).toBe("EMAIL_GENERATED");
  });

  it("does not create a new draft if Gmail reconciliation fails", async () => {
    const memory = memoryStore();
    const gmail = gateway();
    gmail.findDraftByProspectId.mockRejectedValueOnce(new Error("Gmail unavailable"));
    const result = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway });
    expect(result).toMatchObject({ failed: 1, created: 0 });
    expect(gmail.createDraft).not.toHaveBeenCalled();
  });

  it("recovers after a timeout whose draft creation actually succeeded", async () => {
    const memory = memoryStore();
    const gmail = gateway();
    const originalCreate = gmail.createDraft.getMockImplementation()!;
    gmail.createDraft.mockImplementationOnce(async () => {
      await originalCreate("encoded-mime");
      throw new Error("Response connection lost");
    });
    const first = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway });
    const second = await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway });
    expect(first.failed).toBe(1);
    expect(second).toMatchObject({ recovered: 1, failed: 0 });
    expect(gmail.createDraft).toHaveBeenCalledTimes(1);
  });

  it("recovers the saved ID after final workflow persistence fails", async () => {
    const memory = memoryStore();
    const gmail = gateway();
    memory.markDraftCreated.mockRejectedValueOnce(new Error("Database unavailable"));
    expect((await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway })).failed).toBe(1);
    expect((await createGmailDrafts({ ...options, store: memory.store, gateway: gmail.gateway })).recovered).toBe(1);
    expect(gmail.createDraft).toHaveBeenCalledTimes(1);
  });
});
