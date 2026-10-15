import { describe, expect, it, vi } from "vitest";

import { startGmailOAuthCallback } from "../src/lib/gmail/oauth-callback.js";

const redirectUri = "http://127.0.0.1:0/oauth2callback";
const state = "test-state";

describe("Gmail loopback OAuth callback", () => {
  it("is listening before returning and processes the authorization code once", async () => {
    const onCode = vi.fn(async () => {});
    const callback = await startGmailOAuthCallback({ redirectUri, state, onCode, timeoutMs: 5_000 });
    expect((await fetch(new URL("/health", callback.callbackUrl))).status).toBe(200);
    const response = await fetch(`${callback.callbackUrl}?state=${state}&code=test-code`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Token saved");
    await callback.completion;
    expect(onCode).toHaveBeenCalledExactlyOnceWith("test-code");
    await expect(fetch(callback.callbackUrl)).rejects.toThrow();
  });

  it("keeps listening after missing codes, stale state and unrelated requests", async () => {
    const onCode = vi.fn(async () => {});
    const callback = await startGmailOAuthCallback({ redirectUri, state, onCode, timeoutMs: 5_000 });
    expect((await fetch(`${callback.callbackUrl}?state=stale&code=x`)).status).toBe(400);
    expect((await fetch(`${callback.callbackUrl}?state=${state}`)).status).toBe(400);
    expect((await fetch(new URL("/favicon.ico", callback.callbackUrl))).status).toBe(404);
    expect(onCode).not.toHaveBeenCalled();
    expect((await fetch(`${callback.callbackUrl}?state=${state}&code=valid`)).status).toBe(200);
    await callback.completion;
    expect(onCode).toHaveBeenCalledExactlyOnceWith("valid");
  });

  it("does not report success when token exchange or persistence fails", async () => {
    const callback = await startGmailOAuthCallback({
      redirectUri, state, timeoutMs: 5_000,
      onCode: async () => { throw new Error("Token exchange failed"); },
    });
    const completion = expect(callback.completion).rejects.toThrow("Token exchange failed");
    const response = await fetch(`${callback.callbackUrl}?state=${state}&code=x`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("authorization complete");
    await completion;
  });

  it("closes the listener when the authorization window expires", async () => {
    const callback = await startGmailOAuthCallback({ redirectUri, state, onCode: async () => {}, timeoutMs: 30 });
    await expect(callback.completion).rejects.toThrow("timed out");
    await expect(fetch(callback.callbackUrl)).rejects.toThrow();
  });

  it("handles Google denial without attempting a token exchange", async () => {
    const onCode = vi.fn(async () => {});
    const callback = await startGmailOAuthCallback({ redirectUri, state, onCode, timeoutMs: 5_000 });
    const completion = expect(callback.completion).rejects.toThrow("declined");
    expect((await fetch(`${callback.callbackUrl}?state=${state}&error=access_denied`)).status).toBe(400);
    await completion;
    expect(onCode).not.toHaveBeenCalled();
  });
});
