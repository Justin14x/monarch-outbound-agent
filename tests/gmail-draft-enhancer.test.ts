import { describe, expect, it, vi } from "vitest";
import { enhanceGmailDraft, type GmailDraftEnhancementStore } from "../src/modules/emails/gmail-draft-enhancer.js";
import type { GmailDraftGateway, GmailDraftRecord } from "../src/lib/gmail/server.js";
import type { Prospect } from "../src/modules/prospects/prospect.types.js";

const ID = "b93a9f95-17cd-4d2f-a803-7b7c0635253f";
const imagePath = `prospects/${ID}/stitch/home.png`;
import sharp from "sharp";

const png = await sharp({ create: { width: 600, height: 1100, channels: 3, background: "#f2e9de" } }).png().toBuffer();

function prospect(overrides: Partial<Prospect> = {}): Prospect {
  return {
    app_image_urls: [{ screen_id: "home", screen_name: "Home", storage_path: imagePath }],
    business_name: "Skin Hub Med Spa", contact_email: "services@skinhubmedspa.com",
    contact_name: null, created_at: "2026-09-21T00:00:00.000Z",
    email_body: "Old body", email_source_url: "https://skinhubmedspa.com/contact",
    email_subject: "Old subject", email_verified: true, error_message: null,
    gmail_draft_id: "draft-existing", gmail_message_id: null,
    id: ID,
    logo_source_url: null, logo_status: "PENDING", normalized_domain: "skinhubmedspa.com",
    original_logo_url: null, retry_count: 0, sent_at: null, stitch_project_id: null,
    stitch_attempt: null,
    stitch_prompt: null, stitch_status: null, transparent_logo_url: null,
    updated_at: "2026-09-21T00:00:00.000Z", website: "https://skinhubmedspa.com",
    workflow_status: "DRAFT_CREATED", ...overrides,
  };
}

function setup(item = prospect()) {
  const store: GmailDraftEnhancementStore = {
    getProspect: vi.fn(async () => item),
  };
  const getDraft = vi.fn(async (): Promise<GmailDraftRecord> => ({ id: "draft-existing", prospectId: ID }));
  const updateDraft = vi.fn(async (id: string, _raw: string) => id);
  const createDraft = vi.fn(async () => "new-draft");
  const gateway = { getDraft, updateDraft, createDraft } as unknown as GmailDraftGateway;
  const downloadPng = vi.fn(async (_path: string) => png);
  const options = { businessName: "Skin Hub Med Spa", store, gateway,
    senderEmail: "contact.monarchsystems@gmail.com", imageStore: { downloadEmailImage: downloadPng } };
  return { options, getDraft, updateDraft, createDraft, downloadPng };
}

describe("explicit existing Gmail draft enhancement", () => {
  it("updates the same draft with unchanged copy and CID image without creating another", async () => {
    const task = setup();
    const result = await enhanceGmailDraft(task.options);
    expect(result.draftId).toBe("draft-existing");
    expect(result.subject).toBe("Old subject");
    expect(result.body).toBe("Old body");
    expect(task.getDraft).toHaveBeenCalledWith("draft-existing");
    expect(task.downloadPng).toHaveBeenCalledWith(imagePath);
    expect(task.updateDraft).toHaveBeenCalledTimes(1);
    const raw = task.updateDraft.mock.calls[0]?.[1] ?? "";
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toMatch(new RegExp(`Content-ID: <app-concept-${ID}-[a-f0-9]{32}@monarch\\.local>`));
    expect(mime).toContain("Subject: Old subject");
    expect(task.createDraft).not.toHaveBeenCalled();
  });

  it("uses three separate stored screens when enhancing an existing draft", async () => {
    const names = ["Home", "Booking", "Community"];
    const paths = names.map((name) => `prospects/${ID}/stitch/${name.toLowerCase()}.png`);
    const task = setup(prospect({ app_image_urls: names.map((name, index) => ({
      screen_id: name.toLowerCase(), screen_name: name, storage_path: paths[index],
    })) }));
    const result = await enhanceGmailDraft(task.options);
    expect(result.imagePaths).toEqual(paths);
    expect(task.downloadPng.mock.calls.map((call) => call[0])).toEqual(paths);
    const mime = Buffer.from(task.updateDraft.mock.calls[0]?.[1] ?? "", "base64url").toString("utf8");
    expect((mime.match(/Content-ID: </g) ?? [])).toHaveLength(1);
    expect(task.updateDraft).toHaveBeenCalledTimes(1);
    expect(task.createDraft).not.toHaveBeenCalled();
  });

  it("keeps a single CID image when the linked signature is present", async () => {
    const paths = ["home", "booking", "community"].map((name) =>
      `prospects/${ID}/stitch/${name}.png`,
    );
    const task = setup(prospect({
      email_body: "Hi Skin Hub Med Spa team,\n\n[Insert three personalized app screenshots]\n\nBest,\nJustin\nMonarch Systems",
      app_image_urls: paths.map((path, index) => ({
        screen_id: String(index), screen_name: ["Home", "Booking", "Community"][index], storage_path: path,
      })),
    }));
    const result = await enhanceGmailDraft(task.options);
    const mime = Buffer.from(task.updateDraft.mock.calls[0]?.[1] ?? "", "base64url").toString("utf8");
    expect(result.draftId).toBe("draft-existing");
    expect((mime.match(/Content-ID: </g) ?? [])).toHaveLength(1);
    expect(mime).not.toContain("monarch-signature-");
    expect(task.updateDraft).toHaveBeenCalledTimes(1);
    expect(task.createDraft).not.toHaveBeenCalled();
  });

  it("refuses missing images or unverified or wrong-status prospects without touching Gmail", async () => {
    for (const item of [
      prospect({ app_image_urls: null }),
      prospect({ email_verified: false }),
      prospect({ workflow_status: "EMAIL_GENERATED" }),
    ]) {
      const task = setup(item);
      await expect(enhanceGmailDraft(task.options)).rejects.toThrow();
      expect(task.updateDraft).not.toHaveBeenCalled();
      expect(task.createDraft).not.toHaveBeenCalled();
    }
  });

  it("refuses a draft with the wrong prospect marker", async () => {
    const task = setup();
    task.getDraft.mockResolvedValueOnce({ id: "draft-existing", prospectId: "someone-else" });
    await expect(enhanceGmailDraft(task.options)).rejects.toThrow("different prospect");
    expect(task.updateDraft).not.toHaveBeenCalled();
  });

  it("accepts a matching draft when Gmail has stripped its custom marker", async () => {
    const task = setup();
    task.getDraft.mockResolvedValue({
      id: "draft-existing", prospectId: null,
      recipient: "services@skinhubmedspa.com", subject: "Old subject", isDraft: true,
    });
    await enhanceGmailDraft(task.options);
    expect(task.updateDraft).toHaveBeenCalledTimes(1);
  });

  it("refuses a markerless draft with a different recipient or subject", async () => {
    for (const mismatch of [
      { recipient: "someone-else@example.com", subject: "Old subject" },
      { recipient: "services@skinhubmedspa.com", subject: "Another subject" },
    ]) {
      const task = setup();
      task.getDraft.mockResolvedValue({ id: "draft-existing", prospectId: null, isDraft: true, ...mismatch });
      await expect(enhanceGmailDraft(task.options)).rejects.toThrow("different prospect");
      expect(task.updateDraft).not.toHaveBeenCalled();
    }
  });
});
