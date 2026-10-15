// Edit the wording here; the renderer only substitutes approved prospect fields.
export const MONARCH_OUTREACH_SENDER_NAME = "Justin";
export const MONARCH_OUTREACH_SIGNATURE_LABEL = "Monarch Systems";
export const MONARCH_OUTREACH_SIGNATURE_URL = "https://www.monarchsystems.app/";

export const MONARCH_OUTREACH_SUBJECT_TEMPLATE =
  "A mobile app idea for {{business_name}}";

export const MONARCH_OUTREACH_BODY_TEMPLATE = `Hi {{business_name}} team,

I'm Justin, founder of Monarch Systems. I put together three screens showing what a branded app for {{business_name}} could look like—making treatments easier to book and helping clients stay connected between visits.

{{visual_sentence}}

If the idea interests you, I can share a more detailed interactive prototype.

If you'd prefer no follow-up, just reply and I'll make sure of it.

Best,
{{sender_name}}
{{signature_company}}`;

export const MONARCH_OUTREACH_VISUAL_SENTENCE =
  "[Insert three personalized app screenshots]";

export const MONARCH_OUTREACH_PLAIN_VISUAL_SENTENCE =
  "Three personalized app screenshots are included in the HTML version of this email.";

// Avoid claiming three finished screens when Stitch assets are unavailable.
export const MONARCH_OUTREACH_NO_VISUAL_BODY_TEMPLATE = `Hi {{business_name}} team,

I'm Justin, founder of Monarch Systems. I have an idea for a branded app that could make treatments easier to book and help clients stay connected to {{business_name}} between visits.

If you're interested, I can share a more detailed interactive prototype.

If you'd prefer no follow-up, just reply and I'll make sure of it.

Best,
{{sender_name}}
{{signature_company}}`;
