import { readFile } from "node:fs/promises";

import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  renderSharedStitchPrompt,
  renderThreeScreenPrompt,
  renderUnifiedThreeScreenPrompt,
  STITCH_CROSS_SCREEN_NAVIGATION_CONSISTENCY,
  STITCH_FINAL_PRESENTATION_QUALITY,
  STITCH_LIQUID_GLASS_STYLE,
  STITCH_PHONE_PRESENTATION,
} from "../src/config/stitch-three-screen-prompts.js";
import type { StitchGateway, StitchScreenMetadata } from "../src/lib/stitch/server.js";
import type { Prospect } from "../src/modules/prospects/prospect.types.js";
import type { StitchBrandReference } from "../src/modules/stitch/brand-reference.js";
import { addSideCanvas } from "../src/modules/stitch/presentation-canvas.js";
import { verifyBlackPhoneFrame } from "../src/modules/stitch/phone-frame-verifier.js";
import {
  commitThreeScreens,
  stageExistingThreeScreens,
  stageThreeScreens,
  type ThreeScreenManifest,
  type ThreeScreenStore,
} from "../src/modules/stitch/three-screen-generator.js";

const PROJECT = "project-1";
const ID = "prospect-1";
let png: Uint8Array;

beforeAll(async () => {
  png = new Uint8Array(await readFile(
    new URL("../assets/stitch/black-phone-presentation-reference.png", import.meta.url),
  ));
});

function prospect(): Prospect {
  return {
    app_image_urls: [{ screen_id: "old", storage_path: `prospects/${ID}/stitch/old.png` }],
    business_name: "Skin Hub Med Spa",
    contact_email: null,
    contact_name: null,
    created_at: "2026-09-21T00:00:00Z",
    email_body: null,
    email_source_url: null,
    email_subject: null,
    email_verified: false,
    error_message: null,
    gmail_draft_id: "draft-1",
    gmail_message_id: null,
    id: ID,
    logo_source_url: null,
    logo_status: "PENDING",
    normalized_domain: "skinhubmedspa.com",
    original_logo_url: null,
    retry_count: 0,
    sent_at: null,
    stitch_project_id: PROJECT,
    stitch_attempt: null,
    stitch_prompt: "old prompt",
    stitch_status: "COMPLETE",
    transparent_logo_url: null,
    updated_at: "2026-09-21T00:00:00Z",
    website: "https://skinhubmedspa.com/",
    workflow_status: "DRAFT_CREATED",
  };
}

function screen(index: number, height = 1804): StitchScreenMetadata {
  return {
    height,
    htmlUrl: null,
    projectId: PROJECT,
    screenId: `screen-${index}`,
    screenName: ["Home / Discovery", "Services / Booking", "Community"][index - 1] ?? `Screen ${index}`,
    screenshotUrl: `https://stitch.example/screen-${index}.png`,
    width: 780,
  };
}

async function thickPhonePng(): Promise<Uint8Array> {
  const svg = `<svg width="780" height="1804" xmlns="http://www.w3.org/2000/svg">
    <rect width="780" height="1804" fill="#edeae5"/>
    <rect x="10" y="4" width="760" height="1796" rx="90" fill="#111"/>
    <rect x="54" y="48" width="672" height="1708" rx="46" fill="#faf9f7"/>
    <rect x="300" y="72" width="180" height="55" rx="27" fill="#080808"/>
  </svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

function harness() {
  const assets = new Map<string, Uint8Array>();
  const store: ThreeScreenStore = {
    uploadNew: vi.fn(async (path, body) => { assets.set(path, body); }),
    download: vi.fn(async (path) => {
      const body = assets.get(path);
      if (!body) throw new Error("missing private asset");
      return body;
    }),
    commit: vi.fn(async () => {}),
  };
  const gateway: StitchGateway = {
    createProject: vi.fn(async () => PROJECT),
    uploadReferenceImage: vi.fn(async (_project, _body, title) =>
      title.includes("Booking") ? "booking-ref"
        : title.includes("Community") ? "community-ref"
          : title.includes("Official") ? "logo-ref"
            : title.includes("black phone") ? "phone-ref" : "home-ref"),
    generate: vi.fn(async () => [screen(1), screen(2), screen(3)]),
    listScreens: vi.fn(async () => []),
  };
  const fetcher = vi.fn(async () => new Response(Buffer.from(png), { status: 200 })) as unknown as typeof fetch;
  const brandResolver = vi.fn(async (): Promise<StitchBrandReference> => ({
    logo: null,
    logoIssue: null,
    paletteSourceUrl: "https://skinhubmedspa.com/wp-content/uploads/elementor/css/post-7.css",
    primaryColor: "#C19557",
    secondaryColor: "#CB9D4A",
  }));
  return { assets, brandResolver, fetcher, gateway, store };
}

describe("controlled three-screen Stitch generation", () => {
  it("keeps the premium brand direction and presentation-quality checks in the shared prompt", () => {
    const prompt = renderSharedStitchPrompt("Skin Hub Med Spa", "https://skinhubmedspa.com/");
    expect(prompt).toContain("elite mobile product design studio");
    expect(prompt).toContain("business's actual logo prominently but tastefully");
    expect(prompt).toContain(STITCH_PHONE_PRESENTATION);
    expect(prompt).toContain("Match the Home screen's canvas aspect ratio");
    expect(prompt).toContain(STITCH_FINAL_PRESENTATION_QUALITY);
    expect(prompt).toContain("No portion of the phone may touch or extend beyond the canvas");
    expect(prompt).toContain("Never truncate important visible copy with ellipses");
    expect(prompt).toContain("### VISUAL DENSITY AND COMPOSITION");
    expect(prompt).toContain("5–7 meaningful visual or interactive content moments");
    expect(prompt).toContain("Rich content density is encouraged when visually organized");
    expect(prompt).toContain("controlled whitespace, efficient screen utilization, sophisticated visual density");
    expect(prompt).toContain(STITCH_CROSS_SCREEN_NAVIGATION_CONSISTENCY);
    expect(prompt).toContain(STITCH_LIQUID_GLASS_STYLE);
    expect(prompt).toContain("generated Home screen as the source of truth");
    expect(prompt).toContain("Do not add a new glassmorphism effect");
    expect(prompt).toContain("Do not turn every content card into glass");
    expect(prompt).toContain("Only the active destination and its active-state styling may change");
    expect(prompt).toContain("Home, Booking, Community, Account");
    expect(prompt).not.toContain("five destinations");
    expect(prompt).toContain("first approved screen as a locked reusable component");
    expect(prompt).not.toContain("spacious");
    expect(prompt).not.toContain("generous whitespace");
    expect(prompt).not.toContain("clutter, dense information");
  });

  it("carries Home's actual material styling into companion screen prompts", () => {
    const previousScreenIds: string[] = [];
    for (const role of ["Home / Discovery", "Services / Booking", "Community"] as const) {
      const prompt = renderThreeScreenPrompt({
        businessName: "Skin Hub Med Spa",
        previousScreenIds,
        role,
        website: "https://skinhubmedspa.com/",
      });
      if (role === "Home / Discovery") {
        expect(prompt).toContain("NON-NEGOTIABLE DEVICE PRESENTATION");
        expect(prompt).toContain("Home, Booking, Community, Account");
      } else {
        expect(prompt).toContain(STITCH_LIQUID_GLASS_STYLE);
        expect(prompt).toContain("four-tab bottom navigation");
      }
      previousScreenIds.push(`screen-${previousScreenIds.length + 1}`);
      if (role !== "Home / Discovery") {
        expect(prompt).toContain("Reuse Screen 1's header controls and bottom navigation material");
      }
    }
  });

  it("promotes the approved med-spa reference and black-phone prompt for Home", () => {
    const prompt = renderThreeScreenPrompt({
      businessName: "Skin Hub Med Spa",
      previousScreenIds: [],
      role: "Home / Discovery",
      website: "https://skinhubmedspa.com/",
    });
    expect(prompt).toContain("MED-SPA LAYOUT REFERENCE");
    expect(prompt).toContain("continuous thin BLACK bezel and black rounded phone outline");
    expect(prompt).toContain("### LOCKED HOME STRUCTURE");
    expect(prompt).toContain("featured booking/treatment card");
    expect(prompt).toContain("Replace every example-specific element");
    expect(prompt).toContain("No logo file is attached separately");
    expect(prompt).toContain("do not reuse the exact photos from the reference image");
    expect(prompt).toContain("Home, Booking, Community, Account");
    expect(prompt).toContain("No doubled or ghosted text");
    expect(prompt).toContain("https://skinhubmedspa.com/");
    expect(prompt).not.toContain("AURA MED SPA");
  });

  it("keeps the production Home wording identical to v2 apart from the business-name variable", async () => {
    const approved = await readFile(
      new URL("../experiments/stitch-prompts/home-medspa-image-reference-v2-black-phone.md", import.meta.url),
      "utf8",
    );
    const production = renderThreeScreenPrompt({
      businessName: "Skin Hub Med Spa",
      previousScreenIds: [],
      role: "Home / Discovery",
      website: "https://skinhubmedspa.com/",
    });
    const normalizeBrandName = (text: string) => text.trim()
      .replaceAll("Skin Hub Med Spa", "{{business_name}}")
      .replaceAll("Skin Hub", "{{business_name}}");
    expect(normalizeBrandName(production)).toBe(normalizeBrandName(approved));
  });

  it("centralizes the unified three-screen brief and locks website branding over layout colors", () => {
    const prompt = renderUnifiedThreeScreenPrompt({
      businessName: "Skin Hub Med Spa",
      website: "https://skinhubmedspa.com/",
      homeReferenceId: "home-ref",
      bookingReferenceId: "booking-ref",
      communityReferenceId: "community-ref",
      phoneReferenceId: "phone-ref",
      logoReferenceId: "logo-ref",
      logoSourceUrl: "https://skinhubmedspa.com/official-logo.png",
      primaryColor: "#C19557",
      secondaryColor: "#CB9D4A",
    });
    expect(prompt).toContain("EXACTLY THREE SEPARATE mobile screen resources");
    expect(prompt).toContain("Home / Discovery, Services / Booking, and Community together");
    expect(prompt).toContain("LOCKED BOTTOM NAVIGATION — COPY THE HOME REFERENCE");
    expect(prompt).toContain("selected-tab capsule must keep the Home reference's exact shape, width, height");
    expect(prompt).toContain("Never enlarge or shrink the selected capsule to fit a longer label such as Community");
    expect(prompt).toContain("ONLY navigation difference is WHICH tab carries the selected capsule");
    expect(prompt).toContain("community-ref");
    expect(prompt).toContain("NON-NEGOTIABLE BLACK PHONE HARDWARE");
    expect(prompt).toContain("Draw ONE consistent thin device shell and reuse its exact outer silhouette");
    expect(prompt).toContain("Do not make the Booking rim thicker");
    expect(prompt).toContain("phone-ref");
    expect(prompt).toContain("Do not copy the different bottom bar shown in the Community reference");
    expect(prompt).toContain("#C19557");
    expect(prompt).toContain("official-logo.png");
    expect(prompt).toContain("Do not redraw, approximate, invent, or replace the mark");
  });

  it("requests all three screens in one call and stages them without a database commit", async () => {
    const h = harness();
    const onScreenGenerated = vi.fn(async () => {});
    const manifest = await stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store, onScreenGenerated,
    });
    expect(h.gateway.createProject).toHaveBeenCalledOnce();
    expect(h.gateway.uploadReferenceImage).toHaveBeenCalledTimes(4);
    expect(vi.mocked(h.gateway.uploadReferenceImage!).mock.calls[2]?.[2])
      .toContain("Community feed body layout reference");
    expect(Buffer.from(vi.mocked(h.gateway.uploadReferenceImage!).mock.calls[2]![1]))
      .toEqual(await readFile(new URL("../assets/stitch/community-medspa-reference.png", import.meta.url)));
    expect(h.gateway.generate).toHaveBeenCalledOnce();
    expect(h.gateway.generate).toHaveBeenCalledWith(expect.objectContaining({
      deviceType: "MOBILE", projectId: PROJECT,
    }));
    const prompt = vi.mocked(h.gateway.generate).mock.calls[0]![0].prompt;
    expect(prompt).toContain("home-ref");
    expect(prompt).toContain("booking-ref");
    expect(prompt).toContain("community-ref");
    expect(prompt).toContain("phone-ref");
    expect(prompt).toContain("#C19557");
    expect(prompt).toContain("EXACTLY THREE SEPARATE mobile screen resources");
    expect(prompt).toContain("Home, Booking, Community, Account");
    expect(prompt).not.toContain("official business logo was extracted");
    expect(h.gateway.listScreens).not.toHaveBeenCalled();
    expect(onScreenGenerated).toHaveBeenCalledTimes(3);
    expect(manifest.version).toBe(3);
    expect(manifest.prompts).toEqual([prompt]);
    expect(manifest.screens.map((item) => item.role)).toEqual([
      "Home / Discovery", "Services / Booking", "Community",
    ]);
    expect(manifest.screens.map((item) => item.storage_path)).toEqual([
      `prospects/${ID}/stitch/screen-1.png`,
      `prospects/${ID}/stitch/screen-2.png`,
      `prospects/${ID}/stitch/screen-3.png`,
    ]);
    expect(manifest.screens.map((item) => item.width)).toEqual([936, 936, 936]);
    for (const image of h.assets.values()) {
      const metadata = await sharp(image).metadata();
      expect(metadata.width).toBe(936);
      expect(metadata.height).toBe(1804);
    }
    expect(h.store.commit).not.toHaveBeenCalled();
    await commitThreeScreens(manifest, h.store);
    expect(h.store.commit).toHaveBeenCalledOnce();
  });

  it("attaches a verified official logo without treating layout examples as brand authorities", async () => {
    const h = harness();
    const brand: StitchBrandReference = {
      logo: {
        body: png,
        confidence: "HIGH",
        contentType: "image/png",
        extension: "png",
        sourceUrl: "https://skinhubmedspa.com/wp-content/uploads/2026/06/cropped-logo-skinhub.png",
      } as StitchBrandReference["logo"],
      logoIssue: null,
      paletteSourceUrl: "https://skinhubmedspa.com/brand.css",
      primaryColor: "#C19557",
      secondaryColor: "#CB9D4A",
    };
    await stageThreeScreens({
      prospect: prospect(), brandResolver: async () => brand, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    });
    expect(h.gateway.uploadReferenceImage).toHaveBeenCalledTimes(5);
    const prompt = vi.mocked(h.gateway.generate).mock.calls[0]![0].prompt;
    expect(prompt).toContain("logo-ref");
    expect(prompt).toContain(brand.logo!.sourceUrl);
    expect(prompt).toContain("Do not redraw, approximate, invent, or replace the mark");
    expect(prompt).toContain("Do not carry over the example Home image's pale champagne-gold");
  });

  it("stops after one failed generation attempt without uploads or a prospect update", async () => {
    const h = harness();
    vi.mocked(h.gateway.generate).mockRejectedValueOnce(new Error("Stitch failed"));
    await expect(stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    })).rejects.toThrow("Stitch failed");
    expect(h.gateway.generate).toHaveBeenCalledOnce();
    expect(h.store.uploadNew).not.toHaveBeenCalled();
    expect(h.store.commit).not.toHaveBeenCalled();
  });

  it("rejects fewer than three independent resources without a retry", async () => {
    const h = harness();
    vi.mocked(h.gateway.generate).mockResolvedValueOnce([screen(1), screen(2)]);
    await expect(stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    })).rejects.toThrow("Expected exactly three independent Stitch screens");
    expect(h.gateway.generate).toHaveBeenCalledOnce();
    expect(h.store.uploadNew).not.toHaveBeenCalled();
    expect(h.store.commit).not.toHaveBeenCalled();
  });

  it("rejects a long composite image", async () => {
    const h = harness();
    vi.mocked(h.gateway.generate).mockResolvedValueOnce([screen(1, 10298), screen(2), screen(3)]);
    await expect(stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    })).rejects.toThrow("too tall");
    expect(h.gateway.generate).toHaveBeenCalledOnce();
    expect(h.store.uploadNew).not.toHaveBeenCalled();
  });

  it("rejects an excessively wide showcase before staging images", async () => {
    const h = harness();
    vi.mocked(h.gateway.generate).mockResolvedValueOnce([
      { ...screen(1, 1024), width: 2560 }, screen(2), screen(3),
    ]);
    await expect(stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    })).rejects.toThrow("too wide for a phone showcase");
    expect(h.store.uploadNew).not.toHaveBeenCalled();
  });

  it("rejects a tiny black phone on matching landscape canvases", async () => {
    const h = harness();
    const widePng = new Uint8Array(await sharp({
      create: { background: "#f4f1eb", channels: 3, width: 2560, height: 2048 },
    }).png().toBuffer());
    h.fetcher = vi.fn(async () => new Response(Buffer.from(widePng), { status: 200 })) as unknown as typeof fetch;
    vi.mocked(h.gateway.generate).mockResolvedValueOnce([1, 2, 3].map((index) => ({
      ...screen(index, 2048), width: 2560,
    })));
    await expect(stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    })).rejects.toThrow("presentation canvas is not portrait-oriented");
    expect(h.store.uploadNew).not.toHaveBeenCalled();
    expect(h.store.commit).not.toHaveBeenCalled();
  });

  it("rejects a screen with a different canvas shape", async () => {
    const h = harness();
    vi.mocked(h.gateway.generate).mockResolvedValueOnce([
      { ...screen(1, 2048), width: 2560 }, screen(2), screen(3),
    ]);
    await expect(stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    })).rejects.toThrow("canvas shape differs from Home / Discovery");
    expect(h.store.uploadNew).not.toHaveBeenCalled();
  });

  it("rejects duplicate screen resources and avoids partial updates", async () => {
    const h = harness();
    vi.mocked(h.gateway.generate).mockResolvedValueOnce([
      screen(1), { ...screen(1), screenName: "Services / Booking" }, screen(3),
    ]);
    await expect(stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    })).rejects.toThrow("did not clearly label independent");
    expect(h.store.uploadNew).not.toHaveBeenCalled();
    expect(h.store.commit).not.toHaveBeenCalled();
  });

  it("normalizes inconsistent Stitch phone outlines before private Storage upload", async () => {
    const h = harness();
    const thick = await thickPhonePng();
    h.fetcher = vi.fn(async (url) => new Response(
      Buffer.from(String(url).includes("screen-2") ? thick : png),
      { status: 200 },
    )) as unknown as typeof fetch;
    const manifest = await stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    });
    expect(h.gateway.generate).toHaveBeenCalledOnce();
    expect(h.store.uploadNew).toHaveBeenCalledTimes(3);
    expect(h.store.commit).not.toHaveBeenCalled();
    const frames = await Promise.all(manifest.screens.map(async (screen) => {
      const saved = h.assets.get(screen.storage_path)!;
      const metadata = await sharp(saved).metadata();
      expect([metadata.width, metadata.height]).toEqual([936, 1804]);
      const frame = await verifyBlackPhoneFrame(saved);
      expect(frame.valid).toBe(true);
      return frame.geometry;
    }));
    expect(frames[1]).toEqual(frames[0]);
    expect(frames[2]).toEqual(frames[0]);
  });

  it("rechecks cross-screen frame consistency before committing a stored set", async () => {
    const h = harness();
    const manifest = await stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    });
    const thick = await addSideCanvas(await thickPhonePng());
    h.assets.set(manifest.screens[1]!.storage_path, thick.body);
    await expect(commitThreeScreens(manifest, h.store))
      .rejects.toThrow(/Services \/ Booking: fixed phone shell differs from Home \/ Discovery/);
    expect(h.store.commit).not.toHaveBeenCalled();
  });

  it("refuses to commit a staged screen whose black frame was lost", async () => {
    const h = harness();
    const manifest = await stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    });
    const unframed = new Uint8Array(await sharp({
      create: { background: "#f8f6f2", channels: 3, height: 1804, width: 936 },
    }).png().toBuffer());
    h.assets.set(manifest.screens[0]!.storage_path, unframed);
    await expect(commitThreeScreens(manifest, h.store))
      .rejects.toThrow("Stored PNG is missing the canonical black phone shell or Dynamic Island");
    expect(h.store.commit).not.toHaveBeenCalled();
  });

  it("recovers existing resources without any new generation call", async () => {
    const h = harness();
    h.gateway.getScreen = vi.fn(async (_projectId, screenId) =>
      screen(Number(screenId.replace("screen-", ""))));
    const manifest = await stageExistingThreeScreens({
      prospect: prospect(),
      screenIds: ["screen-1", "screen-2", "screen-3"],
      gateway: h.gateway,
      fetcher: h.fetcher,
      store: h.store,
    });
    expect(h.gateway.getScreen).toHaveBeenCalledTimes(3);
    expect(h.gateway.generate).not.toHaveBeenCalled();
    expect(manifest.screens).toHaveLength(3);
    expect(h.store.commit).not.toHaveBeenCalled();
  });

  it("recovers a recorded attempt from its new project and preserves the fixed presentation", async () => {
    const h = harness();
    h.gateway.getScreen = vi.fn(async (_projectId, screenId) =>
      screen(Number(screenId.replace("screen-", ""))));
    const candidate = prospect();
    candidate.stitch_project_id = "previous-approved-project";
    candidate.stitch_attempt = {
      project_id: PROJECT,
      prompt: "approved unified prompt",
      started_at: "2026-10-20T00:00:00Z",
      validated: true,
      screens: [1, 2, 3].map((index) => ({ screen_id: `screen-${index}` })),
    };
    const manifest = await stageExistingThreeScreens({
      prospect: candidate,
      screenIds: ["screen-1", "screen-2", "screen-3"],
      gateway: h.gateway,
      fetcher: h.fetcher,
      store: h.store,
    });
    expect(h.gateway.getScreen).toHaveBeenCalledWith(PROJECT, "screen-1");
    expect(h.gateway.generate).not.toHaveBeenCalled();
    expect(manifest.version).toBe(3);
    expect(manifest.originalProjectId).toBe("previous-approved-project");
    expect(manifest.prompts).toEqual(["approved unified prompt"]);
    expect(manifest.screens.map((item) => [item.width, item.height]))
      .toEqual([[936, 1804], [936, 1804], [936, 1804]]);
    await commitThreeScreens(manifest, h.store);
    expect(h.store.commit).toHaveBeenCalledOnce();
  });

  it("saves generation metadata before a Storage failure so no retry is needed", async () => {
    const h = harness();
    const onPrepared = vi.fn(async (_manifest: ThreeScreenManifest) => {});
    vi.mocked(h.store.uploadNew).mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway, fetcher: h.fetcher,
      store: h.store, onPrepared,
    })).rejects.toThrow("Storage unavailable");
    expect(h.gateway.generate).toHaveBeenCalledOnce();
    expect(h.store.uploadNew).toHaveBeenCalledOnce();
    expect(onPrepared).toHaveBeenCalledOnce();
    expect(onPrepared.mock.calls[0]?.[0].screens.map((item) => item.screen_id)).toEqual([
      "screen-1", "screen-2", "screen-3",
    ]);
    expect(h.store.commit).not.toHaveBeenCalled();
  });

  it("durably records the project and screen IDs before downloading and preserves commit CAS", async () => {
    const h = harness();
    const attempts: Array<{ phase: string; screens: Array<{ screen_id: string }> }> = [];
    h.store.recordAttempt = vi.fn(async (_prospect, attempt) => {
      attempts.push({ phase: attempt.phase, screens: attempt.screens });
      return `2026-10-20T00:00:0${attempts.length}Z`;
    });
    const manifest = await stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    });
    expect(attempts.map((item) => item.phase)).toEqual([
      "PROJECT_CREATED", "SCREENS_RETURNED", "SCREENS_VALIDATED", "ASSETS_STORED",
    ]);
    expect(attempts[1]!.screens.map((item) => item.screen_id))
      .toEqual(["screen-1", "screen-2", "screen-3"]);
    expect(manifest.originalUpdatedAt).toBe("2026-10-20T00:00:04Z");
    expect(h.store.commit).not.toHaveBeenCalled();
  });

  it("retries a transient Storage failure with the exact same bytes and no Stitch regeneration", async () => {
    const h = harness();
    const originalUpload = h.store.uploadNew;
    let failedOnce = false;
    h.store.uploadNew = vi.fn(async (path, body) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("fetch failed");
      }
      await originalUpload(path, body);
    });
    await stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    });
    const calls = vi.mocked(h.store.uploadNew).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0]![0]).toBe(calls[1]![0]);
    expect(Buffer.from(calls[0]![1])).toEqual(Buffer.from(calls[1]![1]));
    expect(h.gateway.generate).toHaveBeenCalledOnce();
  });

  it("reconciles a generation timeout read-only and records its phase without retrying generation", async () => {
    const h = harness();
    const attempts: Array<{ phase: string; screens: Array<{ screen_id: string }>; error?: string }> = [];
    h.store.recordAttempt = vi.fn(async (_prospect, attempt) => {
      attempts.push(attempt);
      return `2026-10-20T00:00:0${attempts.length}Z`;
    });
    vi.mocked(h.gateway.generate).mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    vi.mocked(h.gateway.listScreens).mockResolvedValueOnce([screen(1), screen(2), screen(3)]);
    await expect(stageThreeScreens({
      prospect: prospect(), brandResolver: h.brandResolver, gateway: h.gateway,
      fetcher: h.fetcher, store: h.store,
    })).rejects.toThrow(/Stitch GENERATE failed after \d+ms/);
    expect(h.gateway.generate).toHaveBeenCalledOnce();
    expect(h.gateway.listScreens).toHaveBeenCalledWith(PROJECT);
    expect(attempts.at(-1)?.phase).toBe("FAILED");
    expect(attempts.at(-1)?.screens.map((item) => item.screen_id))
      .toEqual(["screen-1", "screen-2", "screen-3"]);
    expect(attempts.at(-1)?.error).toContain("GENERATE:");
    expect(h.store.uploadNew).not.toHaveBeenCalled();
  });
});
