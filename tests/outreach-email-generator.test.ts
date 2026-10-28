import { describe, expect, it, vi } from "vitest";

import {
  generateOutreachEmails,
  OutreachEmailError,
  renderOutreachEmail,
  type OutreachEmailStore,
} from "../src/modules/emails/outreach-email-generator.js";
import type { Prospect } from "../src/modules/prospects/prospect.types.js";

function prospect(overrides: Partial<Prospect> = {}): Prospect {
  return {
    app_image_urls: null,
    business_name: "Skin Hub Med Spa",
    contact_email: "services@skinhubmedspa.com",
    contact_name: null,
    created_at: "2026-09-21T00:00:00.000Z",
    email_body: null,
    email_source_url: "https://skinhubmedspa.com/",
    email_subject: null,
    email_verified: true,
    error_message: null,
    gmail_draft_id: null,
    gmail_message_id: null,
    id: "prospect-1",
    logo_source_url: null,
    logo_status: "READY",
    normalized_domain: "skinhubmedspa.com",
    original_logo_url: null,
    retry_count: 0,
    sent_at: null,
    stitch_project_id: null,
    stitch_attempt: null,
    stitch_prompt: null,
    stitch_status: "FAILED",
    transparent_logo_url: null,
    updated_at: "2026-09-21T00:00:00.000Z",
    website: "https://skinhubmedspa.com",
    workflow_status: "EMAIL_FOUND",
    ...overrides,
  };
}

describe("approved outreach email template", () => {
  it("uses safe fallback wording without claiming unavailable screenshots", () => {
    const email = renderOutreachEmail(prospect());

    expect(email).toEqual({
      subject: "A mobile app idea for Skin Hub Med Spa",
      body: `Hi Skin Hub Med Spa team,

An industry report found that 73% of med spa patients are repeat customers, highlighting how important it is to keep clients coming back. A branded mobile app can help encourage those repeat visits.

I have an idea for a branded app that could make treatments easier to book and help clients stay connected to Skin Hub Med Spa between visits.

If the idea interests you, I can share a more detailed interactive prototype.

If you'd prefer no follow-up, just reply and I'll make sure of it.

Best,
Justin
Monarch Systems

505 Boyett St #A, College Station, TX 77840`,
      hasVisual: false,
    });
  });

  it("renders the exact approved copy when three separate screens are stored", () => {
    const email = renderOutreachEmail(
      prospect({
        contact_name: "Jamie Rivera",
        app_image_urls: [1, 2, 3].map((number) => ({
          screen_id: `screen-${number}`,
          storage_path: `prospects/prospect-1/stitch/screen-${number}.png`,
        })),
      }),
    );

    expect(email).toEqual({
      subject: "A mobile app idea for Skin Hub Med Spa",
      body: `Hi Skin Hub Med Spa team,

An industry report found that 73% of med spa patients are repeat customers, highlighting how important it is to keep clients coming back. A branded mobile app can help encourage those repeat visits.

I put together three screens showing what your own branded mobile app could look like, designed to encourage repeat bookings and keep clients connected to Skin Hub Med Spa between visits.

[Insert three personalized app screenshots]

If the idea interests you, I can share a more detailed interactive prototype.

If you'd prefer no follow-up, just reply and I'll make sure of it.

Best,
Justin
Monarch Systems

505 Boyett St #A, College Station, TX 77840`,
      hasVisual: true,
    });
  });

  it("does not claim a visual for unrelated or malformed metadata", () => {
    const email = renderOutreachEmail(
      prospect({
        app_image_urls: [
          "https://example.com/image.png",
          {
            screen_id: "other",
            storage_path: "prospects/another-prospect/stitch/other.png",
          },
        ],
      }),
    );

    expect(email.hasVisual).toBe(false);
    expect(email.body).not.toContain("three personalized screens");
    expect(email.body).not.toContain("[Insert three personalized app screenshots]");
  });

  it("does not claim three screens when only one valid screen exists", () => {
    const email = renderOutreachEmail(prospect({
      app_image_urls: [{ screen_id: "home", storage_path: "prospects/prospect-1/stitch/home.png" }],
    }));
    expect(email.hasVisual).toBe(false);
    expect(email.body).not.toContain("three personalized screens");
  });

  it("rejects unverified or incomplete contact evidence", () => {
    expect(() => renderOutreachEmail(prospect({ email_verified: false }))).toThrow(
      OutreachEmailError,
    );
    expect(() => renderOutreachEmail(prospect({ contact_email: null }))).toThrow(
      "Verified contact email and source URL are required",
    );
    expect(() => renderOutreachEmail(prospect({ email_source_url: null }))).toThrow(
      "Verified contact email and source URL are required",
    );
  });

  it("keeps prospect names to one line in the subject", () => {
    const email = renderOutreachEmail(
      prospect({ business_name: "Skin Hub\r\nInjected" }),
    );
    expect(email.subject).toBe("A mobile app idea for Skin Hub Injected");
  });
});

describe("outreach email persistence", () => {
  it("selects an exact business, saves once, and excludes the generated row on rerun", async () => {
    let item = prospect();
    const saveGenerated = vi.fn(async (_id, email) => {
      item = {
        ...item,
        email_body: email.body,
        email_subject: email.subject,
        workflow_status: "EMAIL_GENERATED",
      };
    });
    const listCandidates = vi.fn(async ({ businessName }) =>
      businessName === item.business_name &&
      item.workflow_status === "EMAIL_FOUND" &&
      item.email_verified
        ? [item]
        : [],
    );
    const store: OutreachEmailStore = { listCandidates, saveGenerated };

    const first = await generateOutreachEmails({
      businessName: "Skin Hub Med Spa",
      store,
    });
    const second = await generateOutreachEmails({
      businessName: "Skin Hub Med Spa",
      store,
    });

    expect(first).toMatchObject({ generated: 1, failed: 0, processed: 1 });
    expect(second).toMatchObject({ generated: 0, failed: 0, processed: 0 });
    expect(listCandidates).toHaveBeenCalledWith({
      businessName: "Skin Hub Med Spa",
      limit: 1,
    });
    expect(saveGenerated).toHaveBeenCalledTimes(1);
    expect(item.workflow_status).toBe("EMAIL_GENERATED");
  });

  it("reports a write failure without claiming generation succeeded", async () => {
    const store: OutreachEmailStore = {
      listCandidates: async () => [prospect()],
      saveGenerated: vi.fn().mockRejectedValue(new Error("Database unavailable")),
    };

    const result = await generateOutreachEmails({
      businessName: "Skin Hub Med Spa",
      store,
    });

    expect(result).toMatchObject({ generated: 0, failed: 1, processed: 1 });
    expect(result.results[0]?.error).toBe("Database unavailable");
  });
});
