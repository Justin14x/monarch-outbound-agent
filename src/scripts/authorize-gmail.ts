import { randomBytes } from "node:crypto";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";

import { auth as googleAuth, gmail as createGmailApi } from "googleapis/build/src/apis/gmail/index.js";
import { sheets as createSheetsApi } from "googleapis/build/src/apis/sheets/index.js";
import { startGmailOAuthCallback } from "../lib/gmail/oauth-callback.js";
import { LEAD_SHEET_SPREADSHEET_ID } from "../config/lead-sheet.js";

import {
  GMAIL_COMPOSE_SCOPE,
  GMAIL_METADATA_SCOPE,
  GOOGLE_SHEETS_SCOPE,
  GMAIL_OAUTH_REDIRECT_URI,
  gmailTokenPath,
  assertGmailAccountMatchesSender,
  loadGmailSenderEmail,
  loadGmailOAuthConfig,
} from "../config/gmail.js";

async function authorize(): Promise<void> {
  const { clientId, clientSecret } = loadGmailOAuthConfig();
  const oauth = new googleAuth.OAuth2(
    clientId,
    clientSecret,
    GMAIL_OAUTH_REDIRECT_URI,
  );
  const senderEmail = loadGmailSenderEmail();
  const state = randomBytes(24).toString("hex");
  const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
  if (!codeChallenge) throw new Error("Google OAuth PKCE challenge was not generated");
  const authorizationUrl = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [GMAIL_COMPOSE_SCOPE, GMAIL_METADATA_SCOPE, GOOGLE_SHEETS_SCOPE],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256" as NonNullable<NonNullable<Parameters<typeof oauth.generateAuthUrl>[0]>["code_challenge_method"]>,
    login_hint: senderEmail,
  });
  const callback = await startGmailOAuthCallback({
    redirectUri: GMAIL_OAUTH_REDIRECT_URI,
    state,
    async onCode(code) {
      const { tokens } = await oauth.getToken({ code, codeVerifier });
      if (!tokens.refresh_token) {
        throw new Error("Google did not provide an offline refresh token");
      }
      oauth.setCredentials(tokens);
      const { data: profile } = await createGmailApi({ version: "v1", auth: oauth }).users.getProfile({ userId: "me" });
      assertGmailAccountMatchesSender(profile.emailAddress, senderEmail);
      await createSheetsApi({ version: "v4", auth: oauth }).spreadsheets.get({
        spreadsheetId: LEAD_SHEET_SPREADSHEET_ID,
        fields: "spreadsheetId",
      });
      const tokenPath = gmailTokenPath();
      const pendingPath = `${tokenPath}.pending-${randomBytes(8).toString("hex")}`;
      try {
        await writeFile(
          pendingPath,
          JSON.stringify({ refresh_token: tokens.refresh_token }) + "\n",
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        await chmod(pendingPath, 0o600);
        await rename(pendingPath, tokenPath);
      } catch (error) {
        await unlink(pendingPath).catch(() => undefined);
        throw error;
      }
      console.log(`Google OAuth token saved securely to ${tokenPath}`);
      console.log(`Authorized Gmail account: ${profile.emailAddress}`);
      console.log("Google Sheet access verified.");
      console.log("No Gmail draft was created or sent.");
    },
  });
  console.log(`OAuth callback listening at ${callback.callbackUrl}`);
  console.log("Keep this process running. Authorization window: 30 minutes.");
  console.log("Open this URL in your browser and authorize the Gmail account:");
  console.log(authorizationUrl);
  await callback.completion;
}

try {
  await authorize();
} catch (error) {
  console.error(
    `GMAIL AUTHORIZATION FAILED\n\n${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
}
