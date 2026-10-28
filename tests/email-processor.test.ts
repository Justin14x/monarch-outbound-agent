import { describe, expect, it, vi } from "vitest";

import {
  discoverProspectEmails,
  type EmailDiscoveryStore,
} from "../src/modules/emails/email-processor.js";
import {
  EmailNotFoundError,
  type VerifiedEmailFinder,
} from "../src/modules/emails/email-finder.js";
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
    logo_source_url: null,
    logo_status: "READY",
    normalized_domain: `${id}.example`,
    original_logo_url: null,
    retry_count: 1,
    sent_at: null,
    stitch_project_id: "stitch-1",
    stitch_attempt: null,
    stitch_prompt: "prompt",
    stitch_status: "COMPLETE",
    transparent_logo_url: null,
    updated_at: "2026-09-21T00:00:00.000Z",
    website: `https://${id}.example`,
    workflow_status: "STITCH_COMPLETE",
    ...overrides,
  };
}

function store(items: Prospect[]) {
  const updates: Array<{ changes: Record<string, unknown>; id: string }> = [];
  const value: EmailDiscoveryStore = {
    listCandidates: vi.fn(async ({ limit }) => items.slice(0, limit)),
    updateProspect: vi.fn(async (id, changes) => {
      updates.push({ changes, id });
    }),
  };
  return { store: value, updates };
}

describe("email discovery processor", () => {
  it("selects only the explicitly scoped eligible prospect", async () => {
    const data = store([prospect("skin")]);
    const finder: VerifiedEmailFinder = {
      find: vi.fn().mockResolvedValue({
        contactName: null,
        email: "services@skin.example",
        sourceUrl: "https://skin.example/contact",
        type: "GENERAL",
      }),
    };

    await discoverProspectEmails({
      allowStitchFailed: true,
      businessName: "Skin Hub Med Spa",
      finder,
      includeNotFound: true,
      store: data.store,
    });

    expect(data.store.listCandidates).toHaveBeenCalledWith({
      allowStitchFailed: true,
      businessName: "Skin Hub Med Spa",
      includeNotFound: true,
      limit: 1,
    });
  });

  it("persists the verified email and its public source", async () => {
    const data = store([prospect("skin")]);
    const finder: VerifiedEmailFinder = {
      find: vi.fn().mockResolvedValue({
        contactName: "Jamie Rivera",
        email: "jamie@skin.example",
        sourceUrl: "https://skin.example/team",
        type: "DECISION_MAKER",
      }),
    };

    const result = await discoverProspectEmails({ finder, store: data.store });

    expect(result).toMatchObject({ processed: 1, found: 1, notFound: 0, failed: 0 });
    expect(data.updates).toEqual([
      {
        id: "skin",
        changes: { error_message: null, workflow_status: "EMAIL_SEARCHING" },
      },
      {
        id: "skin",
        changes: {
          contact_email: "jamie@skin.example",
          contact_name: "Jamie Rivera",
          email_source_url: "https://skin.example/team",
          email_verified: true,
          error_message: null,
          workflow_status: "EMAIL_FOUND",
        },
      },
    ]);
  });

  it("records EMAIL_NOT_FOUND without inventing contact fields", async () => {
    const data = store([prospect("none")]);
    const finder: VerifiedEmailFinder = {
      find: vi.fn().mockRejectedValue(new EmailNotFoundError("No public email")),
    };

    const result = await discoverProspectEmails({ finder, store: data.store });

    expect(result).toMatchObject({ found: 0, notFound: 1, failed: 0 });
    expect(data.updates.at(-1)?.changes).toEqual({
      contact_email: null,
      contact_name: null,
      email_source_url: null,
      email_verified: false,
      error_message: null,
      workflow_status: "EMAIL_NOT_FOUND",
    });
  });

  it("records a technical failure and increments retry_count", async () => {
    const data = store([prospect("broken", { retry_count: 4 })]);
    const finder: VerifiedEmailFinder = {
      find: vi.fn().mockRejectedValue(new Error("Website unavailable")),
    };

    const result = await discoverProspectEmails({ finder, store: data.store });

    expect(result).toMatchObject({ found: 0, notFound: 0, failed: 1 });
    expect(data.updates.at(-1)?.changes).toMatchObject({
      error_message: "Website unavailable",
      retry_count: 5,
      workflow_status: "FAILED",
    });
  });

  it("continues processing after one prospect fails", async () => {
    const data = store([prospect("first"), prospect("second")]);
    const finder: VerifiedEmailFinder = {
      find: vi
        .fn()
        .mockRejectedValueOnce(new Error("Temporary failure"))
        .mockResolvedValueOnce({
          contactName: null,
          email: "hello@second.example",
          sourceUrl: "https://second.example/contact",
          type: "GENERAL",
        }),
    };

    const result = await discoverProspectEmails({
      finder,
      limit: 2,
      store: data.store,
    });

    expect(result).toMatchObject({ processed: 2, found: 1, failed: 1 });
  });

  it("is idempotent when a not-found prospect is explicitly retried", async () => {
    const data = store([
      prospect("retry", { workflow_status: "EMAIL_NOT_FOUND" }),
    ]);
    const finder: VerifiedEmailFinder = {
      find: vi.fn().mockResolvedValue({
        contactName: null,
        email: "contact@retry.example",
        sourceUrl: "https://retry.example/contact",
        type: "GENERAL",
      }),
    };

    const first = await discoverProspectEmails({
      finder,
      includeNotFound: true,
      store: data.store,
    });
    const second = await discoverProspectEmails({
      finder,
      includeNotFound: true,
      store: data.store,
    });

    expect(first.results[0]).toEqual(second.results[0]);
    expect(
      data.updates.filter(({ changes }) => changes.workflow_status === "EMAIL_FOUND"),
    ).toHaveLength(2);
  });
});
