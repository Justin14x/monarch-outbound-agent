import { readFile } from "node:fs/promises";

import { auth as googleAuth, gmail as createGmailApi, type gmail_v1 } from "googleapis/build/src/apis/gmail/index.js";

import {
  assertGmailAccountMatchesSender,
  GMAIL_OAUTH_REDIRECT_URI,
  gmailTokenPath,
  loadGmailOAuthConfig,
  loadGmailSenderEmail,
} from "../../config/gmail.js";

export interface GmailDraftRecord {
  id: string;
  prospectId: string | null;
  recipient?: string | null;
  subject?: string | null;
  isDraft?: boolean;
}

export interface GmailDraftGateway {
  createDraft(raw: string): Promise<string>;
  updateDraft(id: string, raw: string): Promise<string>;
  findDraftByProspectId(prospectId: string): Promise<GmailDraftRecord | null>;
  getDraft(id: string): Promise<GmailDraftRecord | null>;
}

export interface ServerGmailGateway {
  gateway: GmailDraftGateway;
  senderEmail: string;
}

export interface GmailReply {
  messageId: string;
  repliedAt: string;
}

export interface GmailReplyGateway {
  findFirstReply(
    sentMessageId: string,
    sentAt: string,
  ): Promise<GmailReply | null>;
}

function headerValue(message: gmail_v1.Schema$Message, name: string): string | null {
  return message.payload?.headers?.find(
    (header) => header.name?.toLowerCase() === name.toLowerCase(),
  )?.value?.trim() || null;
}

function addressFromHeader(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/<([^<>\s]+@[^<>\s]+)>|([^\s<>(),;]+@[^\s<>(),;]+)/);
  return (match?.[1] ?? match?.[2] ?? null)?.toLowerCase() ?? null;
}

export function createGoogleGmailReplyGateway(gmail: gmail_v1.Gmail): GmailReplyGateway {
  return {
    async findFirstReply(sentMessageId, sentAt) {
      const { data: sent } = await gmail.users.messages.get({
        userId: "me",
        id: sentMessageId,
        format: "metadata",
        metadataHeaders: ["From", "To", "Date"],
      });
      if (!sent.id || !sent.threadId || !sent.labelIds?.includes("SENT")) {
        throw new Error(`Gmail message ${sentMessageId} is not a confirmed sent message`);
      }
      const sentTime = Date.parse(sentAt);
      if (!Number.isFinite(sentTime)) throw new Error("Prospect sent_at is invalid");
      const to = headerValue(sent, "To");
      if (!to || to.includes(",") || to.includes(";")) {
        throw new Error(`Gmail message ${sentMessageId} must have exactly one To recipient`);
      }
      const expectedSender = addressFromHeader(to);
      if (!expectedSender) {
        throw new Error(`Gmail message ${sentMessageId} has no usable To recipient`);
      }
      const { data: thread } = await gmail.users.threads.get({
        userId: "me",
        id: sent.threadId,
        format: "metadata",
        metadataHeaders: ["From", "Date"],
      });
      const replies = (thread.messages ?? [])
        .filter((message) => message.id && message.id !== sent.id)
        .map((message) => ({
          message,
          timestamp: Number(message.internalDate),
          sender: addressFromHeader(headerValue(message, "From")),
        }))
        .filter(({ timestamp, sender }) =>
          Number.isFinite(timestamp) && timestamp > sentTime && sender === expectedSender,
        )
        .sort((left, right) => left.timestamp - right.timestamp);
      const first = replies[0];
      return first?.message.id
        ? { messageId: first.message.id, repliedAt: new Date(first.timestamp).toISOString() }
        : null;
    },
  };
}

function extractProspectId(draft: gmail_v1.Schema$Draft): string | null {
  const header = draft.message?.payload?.headers?.find(
    (item) => item.name?.toLowerCase() === "x-monarch-prospect-id",
  );
  return header?.value?.trim() || null;
}

function draftHeader(draft: gmail_v1.Schema$Draft, name: string): string | null {
  return draft.message?.payload?.headers?.find(
    (item) => item.name?.toLowerCase() === name,
  )?.value?.trim() || null;
}

function mimeHeader(part: gmail_v1.Schema$MessagePart, name: string): string | null {
  return part.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function mimeParts(part: gmail_v1.Schema$MessagePart): gmail_v1.Schema$MessagePart[] {
  return [part, ...(part.parts ?? []).flatMap(mimeParts)];
}

function inlineContentIds(raw: string): string[] {
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  return [...mime.matchAll(/^Content-ID: <([^<>\r\n]+)>\r?$/gm)].map((match) => match[1]!);
}

function htmlImageContentIds(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\bsrc=["']cid:([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1]!);
}

function assertMonarchDraftImagePlacement(draft: gmail_v1.Schema$Draft): void {
  const root = draft.message?.payload;
  if (!root || !extractProspectId(draft) || !draft.message?.labelIds?.includes("DRAFT")) return;
  const parts = mimeParts(root);
  const images = parts.filter((part) => part.mimeType === "image/png" || part.mimeType === "image/jpeg");
  if (!images.length) return;
  const html = parts.find((part) => part.mimeType === "text/html")?.body?.data;
  if (!html) throw new Error("Monarch Gmail draft is missing its HTML image layout");
  const screenParts: Array<{ order: number; contentId: string }> = [];
  let signatureId: string | null = null;
  for (const part of images) {
    const filename = part.filename || mimeHeader(part, "Content-Disposition")?.match(/filename="?([^";]+)"?/i)?.[1];
    const contentId = mimeHeader(part, "Content-ID")?.replace(/^<|>$/g, "");
    const screen = filename?.match(/^app-screen-(\d+)\.(?:png|jpg)$/i);
    if (!contentId || !/^inline(?:;|$)/i.test(mimeHeader(part, "Content-Disposition") ?? "")) {
      throw new Error("Monarch Gmail draft has an invalid inline image part");
    }
    if (screen) screenParts.push({ order: Number(screen[1]), contentId });
    else if (filename === "monarch-systems-logo.png" && !signatureId) signatureId = contentId;
    else throw new Error("Monarch Gmail draft has an unexpected inline image");
  }
  screenParts.sort((left, right) => left.order - right.order);
  const expected = [...screenParts.map((part) => part.contentId), ...(signatureId ? [signatureId] : [])];
  const actual = htmlImageContentIds(Buffer.from(html, "base64url").toString("utf8"));
  if (actual.length !== expected.length || actual.some((contentId, index) => contentId !== expected[index])) {
    throw new Error("Monarch Gmail draft has swapped showcase or signature images");
  }
}

function requestedHtmlImageContentIds(mime: string): string[] {
  const match = mime.match(/Content-Type: text\/html;[^\r\n]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/i);
  if (!match) return [];
  const html = Buffer.from(match[1]!.replace(/\s/g, ""), "base64").toString("utf8");
  return htmlImageContentIds(html);
}

export function assertGmailDraftRetainsInlineImages(
  draft: gmail_v1.Schema$Draft,
  expectedContentIds: readonly string[],
  expectedHtmlImageOrder: readonly string[] = expectedContentIds,
): void {
  if (!expectedContentIds.length) return;
  const root = draft.message?.payload;
  if (!draft.message?.labelIds?.includes("DRAFT") || root?.mimeType !== "multipart/related") {
    throw new Error("Gmail did not retain the inline-image draft as multipart/related");
  }
  const parts = mimeParts(root);
  const images = parts.filter((part) => part.mimeType === "image/png" || part.mimeType === "image/jpeg");
  const html = parts.find((part) => part.mimeType === "text/html");
  const htmlText = html?.body?.data
    ? Buffer.from(html.body.data, "base64url").toString("utf8")
    : "";
  if (images.length !== expectedContentIds.length || !htmlText) {
    throw new Error("Gmail draft is missing an inline image or HTML body");
  }
  for (const contentId of expectedContentIds) {
    const image = images.find((part) => mimeHeader(part, "Content-ID") === `<${contentId}>`);
    if (!image || !/^inline(?:;|$)/i.test(mimeHeader(image, "Content-Disposition") ?? "") ||
        !htmlText.includes(`cid:${contentId}`)) {
      throw new Error(`Gmail did not retain inline image ${contentId}`);
    }
  }
  const storedHtmlImageOrder = htmlImageContentIds(htmlText);
  if (storedHtmlImageOrder.length !== expectedHtmlImageOrder.length ||
      storedHtmlImageOrder.some((contentId, index) => contentId !== expectedHtmlImageOrder[index])) {
    throw new Error("Gmail reordered or swapped inline images in the draft HTML");
  }
}

async function verifyStoredInlineDraft(gmail: gmail_v1.Gmail, id: string, raw: string): Promise<void> {
  const expectedContentIds = inlineContentIds(raw);
  if (!expectedContentIds.length) return;
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  const expectedHtmlImageOrder = requestedHtmlImageContentIds(mime);
  if (mime.includes("Content-Type: text/html") && expectedHtmlImageOrder.length !== expectedContentIds.length) {
    throw new Error("Outgoing Gmail draft HTML does not reference each inline image exactly once");
  }
  const { data } = await gmail.users.drafts.get({ userId: "me", id, format: "full" });
  assertGmailDraftRetainsInlineImages(
    data,
    expectedContentIds,
    expectedHtmlImageOrder.length ? expectedHtmlImageOrder : expectedContentIds,
  );
}

export function createGoogleGmailDraftGateway(
  gmail: gmail_v1.Gmail,
): GmailDraftGateway {
  return {
    async createDraft(raw) {
      const { data } = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw } },
      }, { retry: false });
      if (!data.id) throw new Error("Gmail created a draft without an ID");
      await verifyStoredInlineDraft(gmail, data.id, raw);
      return data.id;
    },

    async updateDraft(id, raw) {
      const { data } = await gmail.users.drafts.update({
        userId: "me",
        id,
        requestBody: { message: { raw } },
      }, { retry: false });
      if (data.id !== id) throw new Error("Gmail returned an unexpected draft ID after update");
      await verifyStoredInlineDraft(gmail, id, raw);
      return id;
    },

    async getDraft(id) {
      try {
        const { data } = await gmail.users.drafts.get({
          userId: "me",
          id,
          format: "full",
        });
        assertMonarchDraftImagePlacement(data);
        return data.id ? {
          id: data.id,
          prospectId: extractProspectId(data),
          recipient: draftHeader(data, "to"),
          subject: draftHeader(data, "subject"),
          isDraft: data.message?.labelIds?.includes("DRAFT") ?? false,
        } : null;
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error.code === 404 || error.code === "404")
        ) {
          return null;
        }
        throw error;
      }
    },

    async findDraftByProspectId(prospectId) {
      let pageToken: string | undefined;
      let matched: GmailDraftRecord | null = null;
      do {
        const { data } = await gmail.users.drafts.list({
          userId: "me",
          maxResults: 500,
          ...(pageToken ? { pageToken } : {}),
        });
        for (const draft of data.drafts ?? []) {
          if (!draft.id) continue;
          const detail = await this.getDraft(draft.id);
          if (detail?.prospectId !== prospectId) continue;
          if (matched && matched.id !== detail.id) {
            throw new Error(
              `Multiple Gmail drafts already exist for prospect ${prospectId}; manual review is required`,
            );
          }
          matched = detail;
        }
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
      return matched;
    },
  };
}

export async function getServerGoogleOAuthClient(): Promise<InstanceType<typeof googleAuth.OAuth2>> {
  const { clientId, clientSecret } = loadGmailOAuthConfig();
  let refreshToken: unknown;
  try {
    const parsed: unknown = JSON.parse(await readFile(gmailTokenPath(), "utf8"));
    refreshToken =
      parsed && typeof parsed === "object" && "refresh_token" in parsed
        ? parsed.refresh_token
        : undefined;
  } catch (error) {
    throw new Error(
      `Gmail OAuth token is unavailable. Run npm run gmail:authorize after configuring Google OAuth.`,
      { cause: error },
    );
  }
  if (typeof refreshToken !== "string" || !refreshToken.trim()) {
    throw new Error("Gmail OAuth token file has no refresh_token");
  }
  const auth = new googleAuth.OAuth2(
    clientId,
    clientSecret,
    GMAIL_OAUTH_REDIRECT_URI,
  );
  auth.setCredentials({ refresh_token: refreshToken });
  const { data: profile } = await createGmailApi({ version: "v1", auth }).users.getProfile({ userId: "me" });
  assertGmailAccountMatchesSender(profile.emailAddress, loadGmailSenderEmail());
  return auth;
}

export async function getServerGmailGateway(): Promise<ServerGmailGateway> {
  const auth = await getServerGoogleOAuthClient();
  return {
    gateway: createGoogleGmailDraftGateway(createGmailApi({ version: "v1", auth })),
    senderEmail: loadGmailSenderEmail(),
  };
}

export async function getServerGmailReplyGateway(): Promise<GmailReplyGateway> {
  const auth = await getServerGoogleOAuthClient();
  return createGoogleGmailReplyGateway(createGmailApi({ version: "v1", auth }));
}
