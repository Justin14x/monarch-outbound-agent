import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  createProspect,
  deleteProspect,
  getProspect,
  updateProspect,
} from "../src/modules/prospects/prospect.repository.js";
import type { Database } from "../src/types/database.generated.js";

const prospect: Database["public"]["Tables"]["prospects"]["Row"] = {
  app_image_urls: null,
  business_name: "Acme Dental",
  contact_email: null,
  contact_name: null,
  created_at: "2026-09-21T00:00:00.000Z",
  email_body: null,
  email_source_url: null,
  email_subject: null,
  email_verified: false,
  error_message: null,
  gmail_draft_id: null,
  gmail_message_id: null,
  id: "6af60149-ea0e-4083-92da-0db1f6675df7",
  logo_source_url: null,
  logo_status: null,
  normalized_domain: "example.com",
  original_logo_url: null,
  retry_count: 0,
  sent_at: null,
  stitch_project_id: null,
  stitch_prompt: null,
  stitch_status: null,
  transparent_logo_url: null,
  updated_at: "2026-09-21T00:00:00.000Z",
  website: "https://example.com",
  workflow_status: "IMPORTED",
};

function asClient(value: unknown): SupabaseClient<Database> {
  return value as SupabaseClient<Database>;
}

describe("prospect CRUD", () => {
  it("creates a prospect and returns the inserted record", async () => {
    const single = vi.fn().mockResolvedValue({ data: prospect, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const client = asClient({ from: vi.fn().mockReturnValue({ insert }) });

    await expect(
      createProspect(
        {
          business_name: "Acme Dental",
          normalized_domain: "example.com",
          website: "https://example.com",
        },
        client,
      ),
    ).resolves.toEqual(prospect);
    expect(insert).toHaveBeenCalledWith({
      business_name: "Acme Dental",
      normalized_domain: "example.com",
      website: "https://example.com",
    });
  });

  it("reads a prospect by id", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: prospect, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    const client = asClient({ from: vi.fn().mockReturnValue({ select }) });

    await expect(getProspect(prospect.id, client)).resolves.toEqual(prospect);
    expect(eq).toHaveBeenCalledWith("id", prospect.id);
  });

  it("updates a prospect and returns the changed record", async () => {
    const updated = { ...prospect, workflow_status: "LOGO_READY" };
    const maybeSingle = vi.fn().mockResolvedValue({ data: updated, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eq = vi.fn().mockReturnValue({ select });
    const update = vi.fn().mockReturnValue({ eq });
    const client = asClient({ from: vi.fn().mockReturnValue({ update }) });

    await expect(
      updateProspect(prospect.id, { workflow_status: "LOGO_READY" }, client),
    ).resolves.toEqual(updated);
    expect(update).toHaveBeenCalledWith({ workflow_status: "LOGO_READY" });
  });

  it("deletes a prospect by id", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { id: prospect.id },
      error: null,
    });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eq = vi.fn().mockReturnValue({ select });
    const remove = vi.fn().mockReturnValue({ eq });
    const client = asClient({ from: vi.fn().mockReturnValue({ delete: remove }) });

    await expect(deleteProspect(prospect.id, client)).resolves.toBeUndefined();
    expect(eq).toHaveBeenCalledWith("id", prospect.id);
  });
});
