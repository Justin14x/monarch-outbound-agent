import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  processTransparentLogos,
  type TransparentLogoStore,
} from "../src/modules/logos/transparent-logo-processor.js";
import type { TransparentLogoGenerator } from "../src/modules/logos/transparent-logo-generator.js";
import type { Prospect } from "../src/modules/prospects/prospect.types.js";

function prospect(
  id: string,
  overrides: Partial<Prospect> = {},
): Prospect {
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
    logo_status: "FOUND",
    normalized_domain: `${id}.example`,
    original_logo_url: `prospects/${id}/logo/original.png`,
    retry_count: 0,
    sent_at: null,
    stitch_project_id: null,
    stitch_prompt: null,
    stitch_status: null,
    transparent_logo_url: null,
    updated_at: "2026-09-21T00:00:00.000Z",
    website: `https://${id}.example`,
    workflow_status: "LOGO_FOUND",
    ...overrides,
  };
}

interface StoreOptions {
  existingTransparent?: Uint8Array | null;
  original?: Uint8Array;
  readBack?: Uint8Array;
  uploadError?: Error;
}

function createStore(prospects: Prospect[], options: StoreOptions = {}) {
  const updates: Array<{
    changes: Record<string, unknown>;
    id: string;
  }> = [];
  const downloadOriginal = vi.fn().mockResolvedValue({
    body: options.original ?? new Uint8Array([1, 2, 3]),
    filename: "original.png",
  });
  const uploadTransparent = options.uploadError
    ? vi.fn().mockRejectedValue(options.uploadError)
    : vi
        .fn()
        .mockResolvedValue(`prospects/${prospects[0]?.id ?? "unknown"}/logo/transparent.png`);
  const store: TransparentLogoStore = {
    downloadOriginal,
    async listEligible(limit) {
      return prospects.slice(0, limit);
    },
    async readExistingTransparent() {
      return options.existingTransparent ?? null;
    },
    async readStored() {
      return options.readBack ?? generatedPng;
    },
    async updateProspect(id, changes) {
      updates.push({ changes, id });
    },
    uploadTransparent,
  };
  return { downloadOriginal, store, updates, uploadTransparent };
}

let generatedPng: Uint8Array;
let opaquePng: Uint8Array;

beforeAll(async () => {
  generatedPng = await sharp({
    create: {
      background: { alpha: 0.4, b: 40, g: 100, r: 200 },
      channels: 4,
      height: 64,
      width: 128,
    },
  })
    .png()
    .toBuffer();
  opaquePng = await sharp({
    create: {
      background: { b: 40, g: 100, r: 200 },
      channels: 3,
      height: 64,
      width: 128,
    },
  })
    .png()
    .toBuffer();
});

describe("transparent logo processor", () => {
  it("downloads an eligible original, uploads a valid PNG, and transitions to READY", async () => {
    const item = prospect("eligible");
    const { downloadOriginal, store, updates, uploadTransparent } = createStore(
      [item],
      { readBack: generatedPng },
    );
    const generator: TransparentLogoGenerator = {
      generate: vi.fn().mockResolvedValue(generatedPng),
    };

    const result = await processTransparentLogos({ generator, store });

    expect(result).toMatchObject({ processed: 1, ready: 1, failed: 0 });
    expect(downloadOriginal).toHaveBeenCalledWith(item.original_logo_url);
    expect(uploadTransparent).toHaveBeenCalledWith(item.id, generatedPng);
    expect(updates[0]).toEqual({
      id: item.id,
      changes: {
        error_message: null,
        logo_status: "PROCESSING",
        workflow_status: "LOGO_PROCESSING",
      },
    });
    expect(updates.at(-1)).toEqual({
      id: item.id,
      changes: {
        error_message: null,
        logo_status: "READY",
        transparent_logo_url: `prospects/${item.id}/logo/transparent.png`,
        workflow_status: "LOGO_READY",
      },
    });
    expect(updates.at(-1)?.changes).not.toHaveProperty("original_logo_url");
    expect(updates.at(-1)?.changes).not.toHaveProperty("logo_source_url");
  });

  it("skips a NOT_FOUND prospect without downloading or calling OpenAI", async () => {
    const nara = prospect("nara", {
      logo_status: "NOT_FOUND",
      original_logo_url: null,
      workflow_status: "LOGO_NOT_FOUND",
    });
    const { downloadOriginal, store, updates } = createStore([nara]);
    const generate = vi.fn();

    const result = await processTransparentLogos({
      generator: { generate },
      store,
    });

    expect(result).toMatchObject({ processed: 1, skipped: 1, ready: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(downloadOriginal).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("records an image API failure and continues with another prospect", async () => {
    const first = prospect("first");
    const second = prospect("second");
    const { store, updates } = createStore([first, second], {
      readBack: generatedPng,
    });
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error("OpenAI unavailable"))
      .mockResolvedValueOnce(generatedPng);

    const result = await processTransparentLogos({
      generator: { generate },
      store,
    });

    expect(result).toMatchObject({ processed: 2, failed: 1, ready: 1 });
    expect(updates).toContainEqual({
      id: first.id,
      changes: {
        error_message: "OpenAI unavailable",
        logo_status: "FAILED",
        workflow_status: "FAILED",
      },
    });
  });

  it("rejects an invalid returned image before upload", async () => {
    const item = prospect("invalid");
    const { store, updates, uploadTransparent } = createStore([item]);
    const result = await processTransparentLogos({
      generator: { generate: async () => new Uint8Array([1, 2, 3]) },
      store,
    });

    expect(result).toMatchObject({ failed: 1, ready: 0 });
    expect(uploadTransparent).not.toHaveBeenCalled();
    expect(updates.at(-1)?.changes).toMatchObject({
      logo_status: "FAILED",
      workflow_status: "FAILED",
    });
  });

  it("rejects a PNG with no transparency before upload", async () => {
    const item = prospect("opaque");
    const { store, uploadTransparent } = createStore([item]);
    const result = await processTransparentLogos({
      generator: { generate: async () => opaquePng },
      store,
    });

    expect(result).toMatchObject({ failed: 1, ready: 0 });
    expect(uploadTransparent).not.toHaveBeenCalled();
  });

  it("records a Supabase upload failure", async () => {
    const item = prospect("upload");
    const { store, updates } = createStore([item], {
      uploadError: new Error("Storage unavailable"),
    });
    const result = await processTransparentLogos({
      generator: { generate: async () => generatedPng },
      store,
    });

    expect(result).toMatchObject({ failed: 1, ready: 0 });
    expect(updates.at(-1)?.changes).toEqual({
      error_message: "Storage unavailable",
      logo_status: "FAILED",
      workflow_status: "FAILED",
    });
  });

  it("skips an already READY prospect without another paid API call", async () => {
    const ready = prospect("ready", {
      logo_status: "READY",
      transparent_logo_url: "prospects/ready/logo/transparent.png",
      workflow_status: "LOGO_READY",
    });
    const { store } = createStore([ready]);
    const generate = vi.fn();

    const result = await processTransparentLogos({
      generator: { generate },
      store,
    });

    expect(result).toMatchObject({ skipped: 1, ready: 0 });
    expect(generate).not.toHaveBeenCalled();
  });

  it("reuses a valid deterministic Storage output without another paid API call", async () => {
    const item = prospect("reusable");
    const { downloadOriginal, store, uploadTransparent } = createStore([item], {
      existingTransparent: generatedPng,
    });
    const generate = vi.fn();

    const result = await processTransparentLogos({
      generator: { generate },
      store,
    });

    expect(result).toMatchObject({ ready: 1, failed: 0 });
    expect(result.results[0]).toMatchObject({ reusedExistingAsset: true });
    expect(generate).not.toHaveBeenCalled();
    expect(downloadOriginal).not.toHaveBeenCalled();
    expect(uploadTransparent).not.toHaveBeenCalled();
  });
});
