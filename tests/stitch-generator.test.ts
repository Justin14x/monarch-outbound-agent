import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
  StitchGateway,
  StitchScreenMetadata,
} from "../src/lib/stitch/server.js";
import { renderMonarchStitchPrompt } from "../src/config/stitch-prompt.js";
import {
  generateStitchApps,
  type StitchGenerationStore,
} from "../src/modules/stitch/stitch-generator.js";
import type { Prospect } from "../src/modules/prospects/prospect.types.js";

function prospect(overrides: Partial<Prospect> = {}): Prospect {
  return {
    app_image_urls: null,
    business_name: "Skin Hub Med Spa",
    contact_email: null,
    contact_name: null,
    created_at: "2026-09-21T00:00:00.000Z",
    email_body: null,
    email_source_url: null,
    email_subject: null,
    email_verified: false,
    error_message: null,
    gmail_draft_id: null,
    gmail_message_id: null,
    id: "prospect-1",
    logo_source_url: null,
    logo_status: "READY",
    normalized_domain: "skinhubmedspa.com",
    original_logo_url: "prospects/prospect-1/logo/original.png",
    retry_count: 2,
    sent_at: null,
    stitch_project_id: null,
    stitch_prompt: "EXACT STORED STEP 6 PROMPT",
    stitch_status: "PENDING",
    transparent_logo_url: "prospects/prospect-1/logo/transparent.png",
    updated_at: "2026-09-21T00:00:00.000Z",
    website: "https://skinhubmedspa.com",
    workflow_status: "STITCH_PENDING",
    ...overrides,
  };
}

function screen(id = "screen-1"): StitchScreenMetadata {
  return {
    height: 844,
    htmlUrl: `https://stitch.example/${id}.html`,
    projectId: "project-1",
    screenId: id,
    screenName: id === "screen-1" ? "Home" : "Booking",
    screenshotUrl: `https://stitch.example/${id}.png`,
    width: 390,
  };
}

interface HarnessOptions {
  item?: Prospect;
  screens?: StitchScreenMetadata[];
}

function harness(options: HarnessOptions = {}) {
  const item = options.item ?? prospect();
  const generatedScreens = options.screens ?? [screen()];
  let generated = false;
  const events: string[] = [];
  const updates: Array<{ changes: Record<string, unknown>; id: string }> = [];
  const uploads: Array<{ body: Uint8Array; path: string }> = [];
  const store: StitchGenerationStore = {
    listCandidates: vi.fn(async ({ businessName, includeFailed, limit }) => {
      events.push(`list:${businessName}:${includeFailed}:${limit}`);
      return [item];
    }),
    updateProspect: vi.fn(async (id, changes) => {
      events.push(
        `update:${String(changes.workflow_status ?? changes.stitch_project_id ?? "other")}`,
      );
      updates.push({ changes, id });
    }),
    uploadScreenshot: vi.fn(async (path, body) => {
      events.push(`upload:${path}`);
      uploads.push({ body, path });
    }),
  };
  const gateway: StitchGateway = {
    createProject: vi.fn(async (title) => {
      events.push(`create:${title}`);
      return "project-1";
    }),
    generate: vi.fn(async (input) => {
      events.push(`generate:${input.deviceType}:${input.prompt}`);
      generated = true;
      return generatedScreens;
    }),
    listScreens: vi.fn(async () => {
      events.push("screens");
      return generated || item.stitch_project_id ? generatedScreens : [];
    }),
  };
  const fetcher = vi.fn(async () =>
    new Response(Buffer.from(screenPng), {
      headers: { "content-type": "image/png" },
      status: 200,
    }),
  ) as unknown as typeof fetch;
  return { events, fetcher, gateway, item, store, updates, uploads };
}

let screenPng: Uint8Array;

beforeAll(async () => {
  screenPng = new Uint8Array(
    await sharp({
      create: {
        background: "#f4f1ec",
        channels: 3,
        height: 844,
        width: 390,
      },
    })
      .png()
      .toBuffer(),
  );
});

describe("Stitch app generation", () => {
  it("requests only an explicitly selected STITCH_PENDING candidate", async () => {
    const value = harness();

    await generateStitchApps({
      businessName: "Skin Hub Med Spa",
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });

    expect(value.store.listCandidates).toHaveBeenCalledWith({
      businessName: "Skin Hub Med Spa",
      includeFailed: false,
      limit: 1,
    });
  });

  it("creates a predictably named project and persists its ID before generation", async () => {
    const value = harness();

    await generateStitchApps({
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });

    expect(value.gateway.createProject).toHaveBeenCalledWith(
      "Monarch - Skin Hub Med Spa",
    );
    expect(value.events.indexOf("update:project-1")).toBeLessThan(
      value.events.findIndex((event) => event.startsWith("generate:")),
    );
  });

  it("reuses an existing project but generates from the direct response", async () => {
    const value = harness({
      item: prospect({ stitch_project_id: "project-1" }),
    });

    const result = await generateStitchApps({
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });

    expect(result.complete).toBe(1);
    expect(value.gateway.createProject).not.toHaveBeenCalled();
    expect(value.gateway.generate).toHaveBeenCalledTimes(1);
    expect(value.gateway.listScreens).not.toHaveBeenCalled();
  });

  it("can retry a failed prospect in a fresh project when explicitly requested", async () => {
    const value = harness({
      item: prospect({
        stitch_project_id: "old-project",
        stitch_status: "FAILED",
        workflow_status: "EMAIL_GENERATED",
      }),
    });
    const result = await generateStitchApps({
      businessName: "Skin Hub Med Spa",
      forceNewProject: true,
      includeFailed: true,
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });
    expect(value.gateway.createProject).toHaveBeenCalledTimes(1);
    expect(value.gateway.generate).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
    }));
    expect(result.results[0]).toMatchObject({
      projectId: "project-1",
      status: "COMPLETE",
      workflowStatus: "EMAIL_GENERATED",
    });
    expect(value.updates.some(({ changes }) => "workflow_status" in changes)).toBe(false);
  });

  it("uses the centralized website prompt and records the exact request", async () => {
    const value = harness();

    await generateStitchApps({
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });

    expect(value.gateway.generate).toHaveBeenCalledWith({
      deviceType: "MOBILE",
      projectId: "project-1",
      prompt: renderMonarchStitchPrompt("Skin Hub Med Spa", "https://skinhubmedspa.com"),
    });
    expect(value.updates[0]?.changes).toMatchObject({
      stitch_prompt: renderMonarchStitchPrompt("Skin Hub Med Spa", "https://skinhubmedspa.com"),
    });
    expect(value.events.some((event) => event.startsWith("logo:"))).toBe(false);
  });

  it("generates without a logo when Step 6 prepared a website-only prompt", async () => {
    const value = harness({
      item: prospect({
        logo_status: "NOT_FOUND",
        stitch_prompt: "WEBSITE-ONLY STEP 6 PROMPT",
        transparent_logo_url: null,
      }),
    });

    await generateStitchApps({
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });

    expect(value.gateway.generate).toHaveBeenCalledWith({
      deviceType: "MOBILE",
      projectId: "project-1",
      prompt: renderMonarchStitchPrompt("Skin Hub Med Spa", "https://skinhubmedspa.com"),
    });
  });

  it("renders the exact successful simplified prompt without logo claims", () => {
    const result = renderMonarchStitchPrompt("Skin Hub Med Spa", "https://skinhubmedspa.com/");
    expect(result).toBe("Create a polished mobile app concept for Skin Hub Med Spa using https://skinhubmedspa.com/ as the business reference. Use the website's branding, services, and content to inspire the app.");
    expect(result).not.toMatch(/logo|attached|reference screen/i);
  });

  it("retrieves and persists multiple screenshots plus structured app_image_urls", async () => {
    const value = harness({ screens: [screen("screen-1"), screen("screen-2")] });

    const result = await generateStitchApps({
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });

    expect(result.results[0]?.screens).toHaveLength(2);
    expect(value.fetcher).toHaveBeenCalledTimes(2);
    expect(value.uploads.map(({ path }) => path)).toEqual([
      "prospects/prospect-1/stitch/screen-1.png",
      "prospects/prospect-1/stitch/screen-2.png",
    ]);
    expect(value.updates.at(-1)?.changes).toMatchObject({
      app_image_urls: [
        expect.objectContaining({
          height: 844,
          project_id: "project-1",
          screen_id: "screen-1",
          storage_path: "prospects/prospect-1/stitch/screen-1.png",
          width: 390,
        }),
        expect.objectContaining({ screen_id: "screen-2" }),
      ],
      stitch_status: "COMPLETE",
      workflow_status: "STITCH_COMPLETE",
    });
  });

  it("marks an empty generation result failed and increments retry_count", async () => {
    const value = harness({ screens: [] });

    const result = await generateStitchApps({
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });

    expect(result).toMatchObject({ complete: 0, failed: 1 });
    expect(result.results[0]?.error).toContain("returned no screens");
    expect(value.updates.at(-1)?.changes).toMatchObject({
      retry_count: 3,
      stitch_status: "FAILED",
      workflow_status: "STITCH_FAILED",
    });
  });

  it("preserves the project ID and records a generation failure", async () => {
    const value = harness();
    vi.mocked(value.gateway.generate).mockRejectedValueOnce(
      new Error("Stitch quota temporarily unavailable"),
    );

    const result = await generateStitchApps({
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });

    expect(result.results[0]).toMatchObject({
      projectId: "project-1",
      status: "FAILED",
      workflowStatus: "STITCH_FAILED",
    });
    expect(value.updates).toContainEqual({
      id: "prospect-1",
      changes: { stitch_project_id: "project-1" },
    });
    expect(value.updates.at(-1)?.changes).toMatchObject({
      error_message: "Stitch quota temporarily unavailable",
      retry_count: 3,
    });
  });

  it("can repair Stitch for a later-stage prospect without rolling back EMAIL_GENERATED", async () => {
    const value = harness({
      item: prospect({
        workflow_status: "EMAIL_GENERATED",
        stitch_status: "FAILED",
        stitch_project_id: "project-1",
      }),
    });
    const result = await generateStitchApps({
      businessName: "Skin Hub Med Spa",
      includeFailed: true,
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });

    expect(result.results[0]).toMatchObject({
      status: "COMPLETE",
      workflowStatus: "EMAIL_GENERATED",
    });
    expect(value.updates.some(({ changes }) => "workflow_status" in changes)).toBe(false);
    expect(value.updates.at(-1)?.changes).toMatchObject({
      stitch_status: "COMPLETE",
      app_image_urls: expect.any(Array),
    });
    expect(value.gateway.generate).toHaveBeenCalledTimes(1);
  });

  it("records screenshot retrieval or Storage persistence failures", async () => {
    const downloadFailure = harness();
    vi.mocked(downloadFailure.fetcher).mockResolvedValueOnce(
      new Response("nope", { status: 502 }),
    );
    const first = await generateStitchApps({
      fetcher: downloadFailure.fetcher,
      gateway: downloadFailure.gateway,
      store: downloadFailure.store,
    });
    expect(first.failed).toBe(1);

    const storageFailure = harness();
    vi.mocked(storageFailure.store.uploadScreenshot).mockRejectedValueOnce(
      new Error("Storage unavailable"),
    );
    const second = await generateStitchApps({
      fetcher: storageFailure.fetcher,
      gateway: storageFailure.gateway,
      store: storageFailure.store,
    });
    expect(second.results[0]?.error).toBe("Storage unavailable");
    expect(storageFailure.updates.at(-1)?.changes).toMatchObject({
      workflow_status: "STITCH_FAILED",
    });
  });

  it("rejects a CDN thumbnail instead of storing it as an app screenshot", async () => {
    const value = harness();
    const thumbnail = await sharp({
      create: { background: "#f4f1ec", channels: 3, height: 512, width: 39 },
    }).png().toBuffer();
    vi.mocked(value.fetcher).mockResolvedValueOnce(
      new Response(thumbnail, { headers: { "content-type": "image/png" } }),
    );
    const result = await generateStitchApps({
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });
    expect(result.failed).toBe(1);
    expect(result.results[0]?.error).toContain("thumbnail");
    expect(value.uploads).toHaveLength(0);
  });

  it("does not regenerate on an idempotent rerun with existing project screens", async () => {
    const value = harness({
      item: prospect({
        app_image_urls: [
          {
            height: 844,
            project_id: "project-1",
            screen_id: "screen-1",
            screen_name: "Home",
            stitch_html_url: "https://stitch.example/screen-1.html",
            stitch_screenshot_url: "https://stitch.example/screen-1.png",
            storage_path: "prospects/prospect-1/stitch/screen-1.png",
            width: 390,
          },
        ],
        stitch_project_id: "project-1",
        workflow_status: "STITCH_PENDING",
      }),
    });

    await generateStitchApps({
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });
    await generateStitchApps({
      fetcher: value.fetcher,
      gateway: value.gateway,
      store: value.store,
    });

    expect(value.gateway.createProject).not.toHaveBeenCalled();
    expect(value.gateway.generate).not.toHaveBeenCalled();
    expect(value.uploads).toHaveLength(0);
  });
});
