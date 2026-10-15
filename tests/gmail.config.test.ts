import { describe, expect, it } from "vitest";

import {
  assertGmailAccountMatchesSender,
  GMAIL_COMPOSE_SCOPE,
  loadGmailOAuthConfig,
  loadGmailSenderEmail,
} from "../src/config/gmail.js";

describe("server-side Gmail OAuth configuration", () => {
  it("requires the OAuth client ID and secret", () => {
    expect(() => loadGmailOAuthConfig({})).toThrow();
    expect(loadGmailOAuthConfig({ GMAIL_OAUTH_CLIENT_ID: "id", GMAIL_OAUTH_CLIENT_SECRET: "secret" })).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("validates the sender and uses Google's compose scope", () => {
    expect(() => loadGmailSenderEmail({})).toThrow();
    expect(() => loadGmailSenderEmail({ GMAIL_SENDER_EMAIL: "not-an-email" })).toThrow();
    expect(loadGmailSenderEmail({ GMAIL_SENDER_EMAIL: "sender@example.com" })).toBe("sender@example.com");
    expect(GMAIL_COMPOSE_SCOPE).toBe("https://www.googleapis.com/auth/gmail.compose");
  });

  it("rejects a token for a different Gmail account", () => {
    expect(() => assertGmailAccountMatchesSender("old@example.com", "new@example.com")).toThrow(/does not match/);
    expect(() => assertGmailAccountMatchesSender(null, "new@example.com")).toThrow(/does not match/);
    expect(() => assertGmailAccountMatchesSender(" New@Example.com ", "new@example.com")).not.toThrow();
  });
});
