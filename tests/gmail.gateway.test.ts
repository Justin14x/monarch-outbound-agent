import type { gmail_v1 } from "googleapis";
import { describe, expect, it, vi } from "vitest";

import {
  assertGmailDraftRetainsInlineImages,
  createGoogleGmailDraftGateway,
} from "../src/lib/gmail/server.js";

const inlineId = "app-screen@example.test";
const inlineRaw = Buffer.from(`Content-Type: multipart/related\r\nContent-ID: <${inlineId}>\r\n`, "utf8")
  .toString("base64url");
const appId = "app-concept@example.test";
const logoId = "monarch-signature@example.test";

function twoImageDraft(swapped = false): gmail_v1.Schema$Draft {
  const htmlIds = swapped ? [logoId, appId] : [appId, logoId];
  return {
    id: "draft-123",
    message: {
      labelIds: ["DRAFT"],
      payload: {
        mimeType: "multipart/related",
        parts: [
          {
            mimeType: "text/html",
            body: { data: Buffer.from(htmlIds.map((id) => `<img src="cid:${id}">`).join(""), "utf8").toString("base64url") },
          },
          ...[logoId, appId].map((id) => ({
            mimeType: id === logoId ? "image/png" : "image/jpeg",
            headers: [
              { name: "Content-ID", value: `<${id}>` },
              { name: "Content-Disposition", value: "inline" },
            ],
          })),
        ],
      },
    },
  };
}

const twoImageHtml = `<img src="cid:${appId}"><img src="cid:${logoId}">`;
const twoImageRaw = Buffer.from([
  "Content-Type: multipart/related; boundary=x",
  "",
  "Content-Type: text/html; charset=UTF-8",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from(twoImageHtml, "utf8").toString("base64"),
  "--x",
  `Content-ID: <${logoId}>`,
  "--x",
  `Content-ID: <${appId}>`,
  "--x--",
].join("\r\n"), "utf8").toString("base64url");

function inlineDraft(options: { rootType?: string; disposition?: string; cid?: string; imageType?: string } = {}): gmail_v1.Schema$Draft {
  return {
    id: "draft-123",
    message: {
      labelIds: ["DRAFT"],
      payload: {
        mimeType: options.rootType ?? "multipart/related",
        parts: [
          {
            mimeType: "text/html",
            body: { data: Buffer.from(`<img src="cid:${inlineId}">`).toString("base64url") },
          },
          {
            mimeType: options.imageType ?? "image/png",
            headers: [
              { name: "Content-ID", value: `<${options.cid ?? inlineId}>` },
              { name: "Content-Disposition", value: options.disposition ?? "inline; filename=\"app.png\"" },
            ],
          },
        ],
      },
    },
  };
}

describe("Gmail inline-image round trip", () => {
  it("accepts a related draft with an HTML CID and inline PNG", () => {
    expect(() => assertGmailDraftRetainsInlineImages(inlineDraft(), [inlineId])).not.toThrow();
    expect(() => assertGmailDraftRetainsInlineImages(inlineDraft({ imageType: "image/jpeg" }), [inlineId])).not.toThrow();
  });

  it("rejects Gmail converting the image to an ordinary attachment", () => {
    expect(() => assertGmailDraftRetainsInlineImages(inlineDraft({ rootType: "multipart/mixed" }), [inlineId]))
      .toThrow("multipart/related");
    expect(() => assertGmailDraftRetainsInlineImages(inlineDraft({ disposition: "attachment; filename=\"app.png\"" }), [inlineId]))
      .toThrow("did not retain inline image");
    expect(() => assertGmailDraftRetainsInlineImages(inlineDraft({ cid: "wrong@example.test" }), [inlineId]))
      .toThrow("did not retain inline image");
  });

  it("rejects a draft whose showcase and signature CIDs are swapped even when both images remain inline", async () => {
    expect(() => assertGmailDraftRetainsInlineImages(twoImageDraft(), [logoId, appId], [appId, logoId])).not.toThrow();
    expect(() => assertGmailDraftRetainsInlineImages(twoImageDraft(true), [logoId, appId], [appId, logoId]))
      .toThrow("reordered or swapped");

    const update = vi.fn().mockResolvedValue({ data: { id: "draft-123" } });
    const get = vi.fn().mockResolvedValue({ data: twoImageDraft(true) });
    const gateway = createGoogleGmailDraftGateway({ users: { drafts: { update, get } } } as unknown as gmail_v1.Gmail);
    await expect(gateway.updateDraft("draft-123", twoImageRaw)).rejects.toThrow("reordered or swapped");
    get.mockResolvedValue({ data: twoImageDraft() });
    await expect(gateway.updateDraft("draft-123", twoImageRaw)).resolves.toBe("draft-123");
  });

  it("refuses to recover an existing Monarch draft with swapped image roles", async () => {
    const swapped = twoImageDraft(true);
    swapped.message!.payload!.headers = [{ name: "X-Monarch-Prospect-ID", value: "prospect-1" }];
    swapped.message!.payload!.parts![1]!.filename = "monarch-systems-logo.png";
    swapped.message!.payload!.parts![2]!.filename = "app-screen-1.jpg";
    const get = vi.fn().mockResolvedValue({ data: swapped });
    const gateway = createGoogleGmailDraftGateway({ users: { drafts: { get } } } as unknown as gmail_v1.Gmail);
    await expect(gateway.getDraft("draft-123")).rejects.toThrow("swapped showcase or signature");

    get.mockResolvedValue({ data: { ...swapped, message: { ...swapped.message, payload: {
      ...swapped.message!.payload,
      parts: [twoImageDraft().message!.payload!.parts![0], ...swapped.message!.payload!.parts!.slice(1)],
    } } } });
    await expect(gateway.getDraft("draft-123")).resolves.toMatchObject({ id: "draft-123", prospectId: "prospect-1", isDraft: true });
  });

  it("checks the persisted Gmail draft after create and update, without sending", async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: "draft-123" } });
    const update = vi.fn().mockResolvedValue({ data: { id: "draft-123" } });
    const get = vi.fn().mockResolvedValue({ data: inlineDraft() });
    const send = vi.fn();
    const gateway = createGoogleGmailDraftGateway({
      users: { drafts: { create, update, get, send } },
    } as unknown as gmail_v1.Gmail);

    expect(await gateway.createDraft(inlineRaw)).toBe("draft-123");
    expect(await gateway.updateDraft("draft-123", inlineRaw)).toBe("draft-123");
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith({ userId: "me", id: "draft-123", format: "full" });
    expect(send).not.toHaveBeenCalled();

    get.mockResolvedValue({ data: inlineDraft({ disposition: "attachment" }) });
    await expect(gateway.updateDraft("draft-123", inlineRaw)).rejects.toThrow("did not retain inline image");
  });
});

describe("official Gmail API draft gateway", () => {
  it("uses only drafts.create and returns the Gmail draft ID", async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: "draft-123" } });
    const send = vi.fn();
    const gmail = {
      users: { drafts: { create, send } },
    } as unknown as gmail_v1.Gmail;
    const gateway = createGoogleGmailDraftGateway(gmail);

    expect(await gateway.createDraft("encoded-mime")).toBe("draft-123");
    expect(create).toHaveBeenCalledWith({
      userId: "me",
      requestBody: { message: { raw: "encoded-mime" } },
    }, { retry: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("replaces only the specified existing draft and never sends", async () => {
    const update = vi.fn().mockResolvedValue({ data: { id: "existing-draft" } });
    const send = vi.fn();
    const gateway = createGoogleGmailDraftGateway({
      users: { drafts: { update, send } },
    } as unknown as gmail_v1.Gmail);
    expect(await gateway.updateDraft("existing-draft", "encoded-mime")).toBe("existing-draft");
    expect(update).toHaveBeenCalledWith({
      userId: "me", id: "existing-draft", requestBody: { message: { raw: "encoded-mime" } },
    }, { retry: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("reconciles drafts across pages using the prospect marker", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: { drafts: [{ id: "other" }], nextPageToken: "page-2" },
      })
      .mockResolvedValueOnce({ data: { drafts: [{ id: "matching" }] } });
    const get = vi.fn(async ({ id }: { id: string }) => ({
      data: {
        id,
        message: {
          labelIds: ["DRAFT"],
          payload: {
            headers: [
              { name: "X-Monarch-Prospect-ID", value: id === "matching" ? "prospect-1" : "other-prospect" },
            ],
          },
        },
      },
    }));
    const create = vi.fn();
    const gateway = createGoogleGmailDraftGateway({
      users: { drafts: { create, list, get } },
    } as unknown as gmail_v1.Gmail);

    expect(await gateway.findDraftByProspectId("prospect-1")).toEqual({
      id: "matching",
      prospectId: "prospect-1",
      recipient: null,
      subject: null,
      isDraft: true,
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith({ userId: "me", id: "matching", format: "full" });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses ambiguous duplicate existing drafts", async () => {
    const list = vi.fn().mockResolvedValue({
      data: { drafts: [{ id: "first" }, { id: "second" }] },
    });
    const get = vi.fn(async ({ id }: { id: string }) => ({
      data: {
        id,
        message: {
          payload: { headers: [{ name: "X-Monarch-Prospect-ID", value: "prospect-1" }] },
        },
      },
    }));
    const gateway = createGoogleGmailDraftGateway({
      users: { drafts: { list, get } },
    } as unknown as gmail_v1.Gmail);
    await expect(gateway.findDraftByProspectId("prospect-1")).rejects.toThrow(
      "Multiple Gmail drafts already exist",
    );
  });
});
