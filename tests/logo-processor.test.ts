import { describe, expect, it } from "vitest";

import {
  processPendingProspectLogos,
  type LogoProcessingStore,
} from "../src/modules/logos/logo-processor.js";
import {
  LogoFinderTechnicalError,
  LogoNotFoundError,
  type DetectedLogo,
  type LogoFinder,
} from "../src/modules/logos/logo-finder.js";
import type { Prospect } from "../src/modules/prospects/prospect.types.js";

function prospect(id: string, businessName: string): Prospect {
  return {
    app_image_urls: null,
    business_name: businessName,
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
    logo_source_url: null,
    logo_status: "PENDING",
    normalized_domain: `${id}.example`,
    original_logo_url: null,
    retry_count: 0,
    sent_at: null,
    stitch_project_id: null,
    stitch_prompt: null,
    stitch_status: null,
    transparent_logo_url: null,
    updated_at: "2026-09-21T00:00:00.000Z",
    website: `https://${id}.example`,
    workflow_status: "IMPORTED",
  };
}

describe("logo batch processor", () => {
  it("continues after failures and persists correct workflow states", async () => {
    const prospects = [
      prospect("found", "Found Company"),
      prospect("missing", "Missing Company"),
      prospect("broken", "Broken Company"),
    ];
    const updates: Array<{ changes: Record<string, unknown>; id: string }> = [];
    const stored = new Map<string, Uint8Array>();
    const logoBody = new Uint8Array([1, 2, 3, 4]);

    const finder: LogoFinder = {
      async find({ businessName }) {
        if (businessName === "Missing Company") {
          throw new LogoNotFoundError("No credible logo candidate");
        }
        if (businessName === "Broken Company") {
          throw new LogoFinderTechnicalError("Website timed out");
        }
        return {
          body: logoBody,
          confidence: "HIGH",
          contentType: "image/svg+xml",
          extension: "svg",
          hasAlpha: true,
          height: 100,
          score: 120,
          sourceUrl: "https://found.example/logo.svg",
          width: 500,
        } satisfies DetectedLogo;
      },
    };
    const store: LogoProcessingStore = {
      async listPending(limit) {
        return prospects.slice(0, limit);
      },
      async readAsset(path) {
        const asset = stored.get(path);
        if (!asset) throw new Error("missing stored fixture");
        return asset;
      },
      async updateProspect(id, changes) {
        updates.push({ changes, id });
      },
      async uploadOriginalLogo(id, logo) {
        const path = `prospects/${id}/logo/original.${logo.extension}`;
        stored.set(path, logo.body);
        return path;
      },
    };

    const result = await processPendingProspectLogos({ finder, store });

    expect(result).toMatchObject({
      processed: 3,
      found: 1,
      notFound: 1,
      failed: 1,
    });
    expect(result.results.map(({ status }) => status)).toEqual([
      "FOUND",
      "NOT_FOUND",
      "FAILED",
    ]);
    expect(updates).toContainEqual({
      id: "found",
      changes: {
        error_message: null,
        logo_source_url: "https://found.example/logo.svg",
        logo_status: "FOUND",
        original_logo_url: "prospects/found/logo/original.svg",
        workflow_status: "LOGO_FOUND",
      },
    });
    expect(updates).toContainEqual({
      id: "missing",
      changes: {
        error_message: "No credible logo candidate",
        logo_status: "NOT_FOUND",
        workflow_status: "LOGO_NOT_FOUND",
      },
    });
    expect(updates).toContainEqual({
      id: "broken",
      changes: {
        error_message: "Website timed out",
        logo_status: "FAILED",
        workflow_status: "FAILED",
      },
    });
  });

  it("does not mark a logo found when Storage read-back differs", async () => {
    const item = prospect("mismatch", "Mismatch Company");
    const updates: Array<Record<string, unknown>> = [];
    const finder: LogoFinder = {
      async find() {
        return {
          body: new Uint8Array([1, 2, 3]),
          confidence: "HIGH",
          contentType: "image/png",
          extension: "png",
          hasAlpha: true,
          height: 100,
          score: 100,
          sourceUrl: "https://mismatch.example/logo.png",
          width: 200,
        };
      },
    };
    const store: LogoProcessingStore = {
      async listPending() {
        return [item];
      },
      async readAsset() {
        return new Uint8Array([9, 9, 9]);
      },
      async updateProspect(_id, changes) {
        updates.push(changes);
      },
      async uploadOriginalLogo() {
        return "prospects/mismatch/logo/original.png";
      },
    };

    const result = await processPendingProspectLogos({ finder, store });

    expect(result).toMatchObject({ failed: 1, found: 0 });
    expect(updates.at(-1)).toMatchObject({
      logo_status: "FAILED",
      workflow_status: "FAILED",
    });
  });
});
