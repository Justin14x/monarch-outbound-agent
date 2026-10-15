import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";

export const GMAIL_DRAFT_LOCK_FILENAME = ".gmail-draft.lock";

// Local CLI execution is serialized across processes. A crash leaves the lock
// behind deliberately: inspect/reconcile Gmail before manually removing it.
export async function withGmailDraftLock<T>(
  operation: () => Promise<T>,
  path = resolve(process.cwd(), GMAIL_DRAFT_LOCK_FILENAME),
): Promise<T> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("Another Gmail draft run is active, or a prior run stopped unexpectedly. Inspect Gmail and confirm no run is active before removing .gmail-draft.lock.");
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(path);
  }
}
