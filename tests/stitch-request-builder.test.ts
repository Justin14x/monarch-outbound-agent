import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  MONARCH_STITCH_LOGO_INSTRUCTION,
  MONARCH_STITCH_PROMPT,
} from "../src/config/stitch-prompt.js";
import {
  prepareStitchRequests,
  type StitchRequestStore,
} from "../src/modules/stitch/stitch-request-builder.js";
import type { Prospect } from "../src/modules/prospects/prospect.types.js";

function prospect(id: string, overrides: Partial<Prospect> = {}): Prospect {
  return {
    app_image_urls: null,
    business_name: `${id} Company`,
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
    id,
    logo_source_url: `https://${id}.example/logo.png`,
    logo_status: "READY",
    normalized_domain: `${id}.example`,
    original_logo_url: `prospects/${id}/logo/original.png`,
    retry_count: 0,
    sent_at: null,
    stitch_project_id: null,
    stitch_prompt: null,
    stitch_status: null,
    transparent_logo_url: `prospects/${id}/logo/transparent.png`,
    updated_at: "2026-09-21T00:00:00.000Z",
    website: `https://${id}.example`,
    workflow_status: "LOGO_READY",
    ...overrides,
  };
}

interface StoreOptions {
  logoError?: Error;
  logo?: Uint8Array;
}

function createStore(prospects: Prospect[], options: StoreOptions = {}) {
  const updates: Array<{ changes: Record<string, unknown>; id: string }> = [];
  const readLogo = options.logoError
    ? vi.fn().mockRejectedValue(options.logoError)
    : vi.fn().mockResolvedValue(options.logo ?? transparentPng);
  const store: StitchRequestStore = {
    async listCandidates(limit) {
      return prospects.slice(0, limit);
    },
    readLogo,
    async updateProspect(id, changes) {
      updates.push({ changes, id });
    },
  };
  return { readLogo, store, updates };
}

let transparentPng: Uint8Array;

beforeAll(async () => {
  transparentPng = await sharp({
    create: {
      background: { alpha: 0.4, b: 30, g: 80, r: 180 },
      channels: 4,
      height: 64,
      width: 128,
    },
  })
    .png()
    .toBuffer();
});

describe("Stitch request builder", () => {
  function expectedPrompt(website: string, hasLogo = false): string {
    return [
      MONARCH_STITCH_PROMPT,
      hasLogo ? MONARCH_STITCH_LOGO_INSTRUCTION : null,
      `This is the website: ${website}`,
    ]
      .filter((part): part is string => part !== null)
      .join(" ");
  }

  it("prepares website, prompt, and a readable transparent logo", async () => {
    const item = prospect("with-logo");
    const { readLogo, store } = createStore([item]);

    const result = await prepareStitchRequests({ store });

    expect(result).toMatchObject({ processed: 1, prepared: 1, failed: 0 });
    expect(result.results[0]?.request).toEqual({
      business_name: "with-logo Company",
      has_logo: true,
      logo_storage_path: "prospects/with-logo/logo/transparent.png",
      stitch_prompt: expectedPrompt("https://with-logo.example", true),
      website: "https://with-logo.example",
    });
    expect(readLogo).toHaveBeenCalledWith(
      "prospects/with-logo/logo/transparent.png",
    );
  });

  it("prepares a valid request for a prospect intentionally using no logo", async () => {
    const item = prospect("without-logo", {
      logo_status: "NOT_FOUND",
      original_logo_url: null,
      transparent_logo_url: null,
      workflow_status: "LOGO_NOT_FOUND",
    });
    const { readLogo, store } = createStore([item]);

    const result = await prepareStitchRequests({ store });

    expect(result).toMatchObject({ prepared: 1, failed: 0 });
    expect(result.results[0]?.request).toMatchObject({
      has_logo: false,
      logo_storage_path: null,
      stitch_prompt: expectedPrompt("https://without-logo.example"),
    });
    expect(result.results[0]?.request?.stitch_prompt).not.toContain(
      MONARCH_STITCH_LOGO_INSTRUCTION,
    );
    expect(readLogo).not.toHaveBeenCalled();
  });

  it("rejects a missing website", async () => {
    const { store, updates } = createStore([
      prospect("missing-website", { website: " " }),
    ]);

    const result = await prepareStitchRequests({ store });

    expect(result).toMatchObject({ prepared: 0, failed: 1 });
    expect(result.results[0]?.error).toBe("website is required");
    expect(updates.at(-1)?.changes).toMatchObject({
      stitch_status: "FAILED",
      workflow_status: "FAILED",
    });
  });

  it("rejects a missing business name", async () => {
    const { store } = createStore([
      prospect("missing-name", { business_name: "" }),
    ]);

    const result = await prepareStitchRequests({ store });

    expect(result).toMatchObject({ prepared: 0, failed: 1 });
    expect(result.results[0]?.error).toBe("business_name is required");
  });

  it("rejects a malformed website", async () => {
    const { store } = createStore([
      prospect("invalid-website", { website: "not a public URL" }),
    ]);

    const result = await prepareStitchRequests({ store });

    expect(result).toMatchObject({ prepared: 0, failed: 1 });
    expect(result.results[0]?.error).toContain("website is invalid");
  });

  it("rejects a missing master prompt", async () => {
    const { store } = createStore([prospect("missing-prompt")]);

    const result = await prepareStitchRequests({ masterPrompt: " ", store });

    expect(result).toMatchObject({ prepared: 0, failed: 1 });
    expect(result.results[0]?.error).toBe("master Stitch prompt is required");
  });

  it("falls back to a website-only request when the logo is missing from Storage", async () => {
    const { store, updates } = createStore([prospect("missing-object")], {
      logoError: new Error("Object not found"),
    });

    const result = await prepareStitchRequests({ store });

    expect(result).toMatchObject({ prepared: 1, failed: 0 });
    expect(result.results[0]?.request).toMatchObject({
      has_logo: false,
      logo_storage_path: null,
      stitch_prompt: expectedPrompt("https://missing-object.example"),
    });
    expect(updates.at(-1)?.changes).toMatchObject({
      error_message: null,
      stitch_status: "PENDING",
      workflow_status: "STITCH_PENDING",
    });
  });

  it("falls back to a website-only request when the logo is not a usable transparent PNG", async () => {
    const { store } = createStore([prospect("invalid-logo")], {
      logo: new TextEncoder().encode("not a PNG"),
    });

    const result = await prepareStitchRequests({ store });

    expect(result).toMatchObject({ prepared: 1, failed: 0 });
    expect(result.results[0]?.request).toMatchObject({
      has_logo: false,
      logo_storage_path: null,
      stitch_prompt: expectedPrompt("https://invalid-logo.example"),
    });
  });

  it("saves the exact centralized prompt and transitions to STITCH_PENDING", async () => {
    const item = prospect("transition");
    const { store, updates } = createStore([item]);

    await prepareStitchRequests({ store });

    expect(updates).toContainEqual({
      id: item.id,
      changes: {
        error_message: null,
        stitch_prompt: expectedPrompt(item.website, true),
        stitch_status: "PENDING",
        workflow_status: "STITCH_PENDING",
      },
    });
  });

  it("rebuilds an existing STITCH_PENDING request deterministically", async () => {
    const item = prospect("rerun", {
      logo_status: "NOT_FOUND",
      original_logo_url: null,
      stitch_prompt: "obsolete prompt",
      stitch_status: "PENDING",
      transparent_logo_url: null,
      workflow_status: "STITCH_PENDING",
    });
    const { readLogo, store, updates } = createStore([item]);

    const first = await prepareStitchRequests({ store });
    const second = await prepareStitchRequests({ store });

    expect(first.results[0]?.request).toEqual(second.results[0]?.request);
    expect(first.results[0]?.request?.stitch_prompt).toBe(
      expectedPrompt(item.website),
    );
    expect(updates).toHaveLength(2);
    expect(readLogo).not.toHaveBeenCalled();
  });

  it("requires an explicit option to bypass a failed logo stage", async () => {
    const item = prospect("logo-failed", {
      logo_status: "FAILED",
      transparent_logo_url: null,
      workflow_status: "FAILED",
    });
    const firstStore = createStore([item]);
    const first = await prepareStitchRequests({ store: firstStore.store });
    expect(first).toMatchObject({ prepared: 0, failed: 1 });

    const secondStore = createStore([item]);
    const second = await prepareStitchRequests({
      includeLogoFailuresAsNoLogo: true,
      store: secondStore.store,
    });
    expect(second).toMatchObject({ prepared: 1, failed: 0 });
    expect(second.results[0]?.request).toMatchObject({
      has_logo: false,
      logo_storage_path: null,
    });
  });
});
