import { resolve } from "node:path";

export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
export const GMAIL_METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
export const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
export const GMAIL_OAUTH_REDIRECT_URI = "http://127.0.0.1:8765/oauth2callback";
export const GMAIL_TOKEN_FILENAME = ".gmail-oauth-token.json";

export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export function loadGmailOAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
): GmailOAuthConfig {
  const clientId = environment.GMAIL_OAUTH_CLIENT_ID?.trim();
  const clientSecret = environment.GMAIL_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET are required",
    );
  }
  return { clientId, clientSecret };
}

export function loadGmailSenderEmail(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const email = environment.GMAIL_SENDER_EMAIL?.trim();
  if (!email || !/^[^\s@<>,;:]+@[^\s@<>,;:]+\.[^\s@<>,;:]+$/.test(email)) {
    throw new Error("GMAIL_SENDER_EMAIL must be a valid Gmail sender address");
  }
  return email;
}

export function assertGmailAccountMatchesSender(
  authenticatedEmail: string | null | undefined,
  senderEmail: string,
): void {
  if (authenticatedEmail?.trim().toLowerCase() !== senderEmail.trim().toLowerCase()) {
    throw new Error(
      `Authorized Gmail account ${authenticatedEmail || "(unknown)"} does not match GMAIL_SENDER_EMAIL ${senderEmail}`,
    );
  }
}

export function gmailTokenPath(): string {
  return resolve(process.cwd(), GMAIL_TOKEN_FILENAME);
}
