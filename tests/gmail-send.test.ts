import { describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "googleapis/build/src/apis/gmail/index.js";

import { createGoogleGmailSendGateway } from "../src/lib/gmail/send.js";
import { MONARCH_OUTREACH_OPT_OUT_SENTENCE, MONARCH_OUTREACH_POSTAL_ADDRESS } from "../src/config/outreach-email-template.js";

const headers = [
  { name: "X-Monarch-Prospect-ID", value: "prospect-1" },
  { name: "To", value: "Spa <hello@spa.example>" },
  { name: "Subject", value: "App idea" },
];

function fixture(includeFooter = true, htmlEscaped = false) {
  const footer = includeFooter ? `\n${MONARCH_OUTREACH_OPT_OUT_SENTENCE}\n${MONARCH_OUTREACH_POSTAL_ADDRESS}` : "";
  const htmlFooter = htmlEscaped ? footer.replaceAll("'", "&#39;") : footer;
  const list = vi.fn(async () => ({ data: { messages: [{ id: "sent-1" }] } }));
  const get = vi.fn(async () => ({ data: { id: "sent-1", labelIds: ["SENT"], internalDate: "1791900000000", payload: { headers } } }));
  const draftGet = vi.fn(async () => ({ data: { id: "draft-1", message: { labelIds: ["DRAFT"], payload: {
    headers, mimeType: "multipart/related", parts: [
      { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/plain", body: { data: Buffer.from(`hello${footer}`).toString("base64url") } },
        { mimeType: "text/html", body: { data: Buffer.from(`<img src="cid:screen@monarch.local"><p>${htmlFooter}</p>`).toString("base64url") } },
      ] },
      { mimeType: "image/jpeg", filename: "app-screen-1.jpg", body: { attachmentId: "image-1" }, headers: [
        { name: "Content-ID", value: "<screen@monarch.local>" },
        { name: "Content-Disposition", value: "inline; filename=\"app-screen-1.jpg\"" },
      ] },
    ],
  } } } }));
  const send = vi.fn(async () => ({ data: { id: "sent-1" } }));
  const gmail = { users: { messages: { list, get }, drafts: { get: draftGet, send } } } as unknown as gmail_v1.Gmail;
  return { gateway: createGoogleGmailSendGateway(gmail), list, get, draftGet, send };
}

describe("Gmail send reconciliation", () => {
  it("finds a prior confirmed Sent message by prospect ID", async () => {
    const test = fixture();
    expect(await test.gateway.findSentByProspectId("prospect-1", "hello@spa.example")).toMatchObject({
      id: "sent-1", recipient: "hello@spa.example", subject: "App idea",
    });
    expect(test.send).not.toHaveBeenCalled();
  });

  it("ignores delivery tests addressed to someone other than the verified business", async () => {
    const test = fixture();
    expect(await test.gateway.findSentByProspectId("prospect-1", "owner@spa.example")).toBeNull();
  });

  it("sends a draft once without Google API retries and confirms its Sent label", async () => {
    const test = fixture();
    expect(await test.gateway.inspectDraft("draft-1")).toMatchObject({ prospectId: "prospect-1", hasShowcase: true, hasRequiredFooter: true });
    await test.gateway.sendDraft("draft-1", "prospect-1");
    expect(test.send).toHaveBeenCalledTimes(1);
    expect(test.send).toHaveBeenCalledWith(expect.objectContaining({ requestBody: { id: "draft-1" } }), { retry: false });
  });

  it("identifies an older draft without the required outreach footer", async () => {
    const test = fixture(false);
    expect(await test.gateway.inspectDraft("draft-1")).toMatchObject({ hasShowcase: true, hasRequiredFooter: false });
    expect(test.send).not.toHaveBeenCalled();
  });

  it("accepts the required footer when apostrophes are escaped in HTML", async () => {
    const test = fixture(true, true);
    expect(await test.gateway.inspectDraft("draft-1")).toMatchObject({ hasShowcase: true, hasRequiredFooter: true });
    expect(test.send).not.toHaveBeenCalled();
  });

  it("rejects messages with multiple recipients or no confirmed Sent label", async () => {
    const test = fixture();
    test.get.mockResolvedValueOnce({ data: { id: "sent-1", labelIds: ["SENT"], internalDate: "1791900000000", payload: { headers: [...headers, { name: "Cc", value: "other@example.com" }] } } });
    await expect(test.gateway.sendDraft("draft-1", "prospect-1")).rejects.toThrow("exactly one To");
    test.get.mockResolvedValueOnce({ data: { id: "sent-1", labelIds: ["DRAFT"], internalDate: "1791900000000", payload: { headers } } });
    await expect(test.gateway.sendDraft("draft-1", "prospect-1")).rejects.toThrow("did not confirm a SENT");
  });
});
