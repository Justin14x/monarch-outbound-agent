import { createServer } from "node:http";

export const GMAIL_AUTHORIZATION_TIMEOUT_MS = 30 * 60 * 1000;

export async function startGmailOAuthCallback(options: {
  redirectUri: string;
  state: string;
  onCode: (code: string) => Promise<void>;
  timeoutMs?: number;
}): Promise<{ callbackUrl: string; completion: Promise<void> }> {
  const redirect = new URL(options.redirectUri);
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1") {
    throw new Error("Gmail OAuth callback must use the local loopback address");
  }
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // The listener may receive a callback before its caller awaits completion.
  void completion.catch(() => {});
  let processing = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", options.redirectUri);
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200).end("Gmail OAuth callback is listening");
      return;
    }
    if (request.method !== "GET" || url.pathname !== redirect.pathname) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (url.searchParams.get("state") !== options.state) {
      response.writeHead(400).end("Invalid OAuth state. Use the current authorization link.");
      return;
    }
    if (processing) {
      response.writeHead(409).end("Authorization is already being processed");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error) {
      response.writeHead(400).end("Google authorization was declined. Restart authorization.");
      rejectCompletion(new Error("Google authorization was declined"));
      return;
    }
    if (!code) {
      response.writeHead(400).end("No authorization code received. Use the current authorization link.");
      return;
    }
    processing = true;
    clearTimeout(timeout);
    void (async () => {
      try {
        await options.onCode(code);
        response.writeHead(200).end("Gmail authorization complete. Token saved. You can close this tab. No email was created or sent.");
        resolveCompletion();
      } catch (cause) {
        response.writeHead(500).end("Authorization token could not be saved. Check the terminal and restart authorization.");
        rejectCompletion(cause instanceof Error ? cause : new Error("Gmail authorization failed"));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(redirect.port), "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth listener did not start");
  redirect.port = String(address.port);
  const timeout = setTimeout(() => {
    rejectCompletion(new Error("Gmail authorization timed out. Restart npm run gmail:authorize and use the new link."));
  }, options.timeoutMs ?? GMAIL_AUTHORIZATION_TIMEOUT_MS);
  const close = () => {
    clearTimeout(timeout);
    server.close();
    server.closeIdleConnections();
  };
  server.on("error", rejectCompletion);
  void completion.then(close, close);
  return { callbackUrl: redirect.href, completion };
}
