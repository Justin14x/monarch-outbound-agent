import { describe, expect, it, vi } from "vitest";

import {
  createWebsiteEmailFinder,
  EmailFinderTechnicalError,
  EmailNotFoundError,
  type PublicEmailSearchProvider,
} from "../src/modules/emails/email-finder.js";
import type { LogoHttpClient } from "../src/modules/logos/safe-http.js";

function resource(html: string, finalUrl: string) {
  return {
    body: new TextEncoder().encode(html),
    contentType: "text/html",
    finalUrl,
  };
}

describe("verified email finder", () => {
  it("follows an official contact page and keeps the exact source URL", async () => {
    const getHtml = vi.fn(async (url: string) => {
      if (url === "https://business.com/") {
        return resource(
          '<a href="/contact/">Contact us</a><p>Welcome to the business.</p>',
          url,
        );
      }
      return resource(
        '<address>Email: <a href="mailto:hello@business.com">hello@business.com</a></address>',
        "https://business.com/contact/",
      );
    });
    const finder = createWebsiteEmailFinder({
      httpClient: { getHtml } as Pick<LogoHttpClient, "getHtml">,
    });

    await expect(
      finder.find({
        businessName: "Business",
        website: "https://business.com/",
      }),
    ).resolves.toEqual({
      contactName: null,
      email: "hello@business.com",
      sourceUrl: "https://business.com/contact/",
      type: "GENERAL",
    });
  });

  it("prefers an explicitly associated owner email over a general address", async () => {
    const html = `
      <p>General email: info@studio.com</p>
      <section><h2>Jamie Rivera, Founder</h2><a href="mailto:jamie@studio.com">Email Jamie</a></section>
    `;
    const finder = createWebsiteEmailFinder({
      httpClient: {
        getHtml: vi.fn().mockResolvedValue(resource(html, "https://studio.com/about")),
      },
    });

    await expect(
      finder.find({ businessName: "Studio", website: "https://studio.com" }),
    ).resolves.toMatchObject({
      contactName: "Jamie Rivera",
      email: "jamie@studio.com",
      type: "DECISION_MAKER",
    });
  });

  it("uses a public source only after the official website has no email", async () => {
    const publicSearch: PublicEmailSearchProvider = {
      search: vi.fn().mockResolvedValue([
        {
          html: "<p>Business contact: office@business.com</p>",
          url: "https://directory.example/business",
        },
      ]),
    };
    const finder = createWebsiteEmailFinder({
      httpClient: {
        getHtml: vi
          .fn()
          .mockResolvedValue(resource("<p>Call us today.</p>", "https://business.com")),
      },
      publicSearch,
    });

    const found = await finder.find({
      businessName: "Business",
      website: "https://business.com",
    });

    expect(found).toMatchObject({
      email: "office@business.com",
      sourceUrl: "https://directory.example/business",
      type: "MANAGEMENT",
    });
    expect(publicSearch.search).toHaveBeenCalledOnce();
  });

  it("never constructs an address when none is publicly listed", async () => {
    const finder = createWebsiteEmailFinder({
      httpClient: {
        getHtml: vi
          .fn()
          .mockResolvedValue(resource("<p>Contact our team by phone.</p>", "https://quiet.example")),
      },
    });

    await expect(
      finder.find({ businessName: "Quiet Co", website: "https://quiet.example" }),
    ).rejects.toBeInstanceOf(EmailNotFoundError);
  });

  it("rejects placeholders and sample addresses", async () => {
    const finder = createWebsiteEmailFinder({
      httpClient: {
        getHtml: vi.fn().mockResolvedValue(
          resource(
            "<p>Template: name@example.com and test@business.example</p>",
            "https://business.example",
          ),
        ),
      },
    });

    await expect(
      finder.find({ businessName: "Business", website: "https://business.example" }),
    ).rejects.toBeInstanceOf(EmailNotFoundError);
  });

  it("distinguishes a technical inspection failure from not found", async () => {
    const finder = createWebsiteEmailFinder({
      httpClient: { getHtml: vi.fn().mockRejectedValue(new Error("DNS failure")) },
    });

    await expect(
      finder.find({ businessName: "Broken", website: "https://broken.example" }),
    ).rejects.toBeInstanceOf(EmailFinderTechnicalError);
  });
});
