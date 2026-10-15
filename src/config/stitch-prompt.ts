// Edit this template to change the wording sent to Stitch. Keep both placeholders.
export const MONARCH_STITCH_PROMPT =
  "Create a polished mobile app concept for {{business_name}} using {{website}} as the business reference. Use the website's branding, services, and content to inspire the app.";

export function renderMonarchStitchPrompt(
  businessName: string,
  website: string,
  template = MONARCH_STITCH_PROMPT,
): string {
  const trimmed = template.trim();
  if (!trimmed) throw new Error("master Stitch prompt is required");
  if (!trimmed.includes("{{business_name}}") || !trimmed.includes("{{website}}")) {
    throw new Error("master Stitch prompt must include {{business_name}} and {{website}}");
  }
  return trimmed
    .replaceAll("{{business_name}}", businessName.trim())
    .replaceAll("{{website}}", website.trim());
}
