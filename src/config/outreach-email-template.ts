// Edit the wording here; the renderer only substitutes approved prospect fields.
export const MONARCH_OUTREACH_SENDER_NAME = "Justin";
export const MONARCH_OUTREACH_SIGNATURE_LABEL = "Monarch Systems";
export const MONARCH_OUTREACH_SIGNATURE_URL = "https://www.monarchsystems.app/";
export const MONARCH_OUTREACH_POSTAL_ADDRESS = "505 Boyett St #A, College Station, TX 77840";
export const MONARCH_OUTREACH_OPT_OUT_SENTENCE =
  "If you'd prefer no follow-up, just reply and I'll make sure of it.";

export const MONARCH_OUTREACH_SUBJECT_TEMPLATE =
  "A mobile app idea for {{business_name}}";

export const MONARCH_OUTREACH_BODY_TEMPLATE = `Hi {{business_name}} team,

An industry report found that 73% of med spa patients are repeat customers, highlighting how important it is to keep clients coming back. A branded mobile app can help encourage those repeat visits.

I put together three screens showing what your own branded mobile app could look like, designed to encourage repeat bookings and keep clients connected to {{business_name}} between visits.

{{visual_sentence}}

If the idea interests you, I can share a more detailed interactive prototype.

${MONARCH_OUTREACH_OPT_OUT_SENTENCE}

Best,
{{sender_name}}
{{signature_company}}

{{postal_address}}`;

export const MONARCH_OUTREACH_VISUAL_SENTENCE =
  "[Insert three personalized app screenshots]";

export const MONARCH_OUTREACH_PLAIN_VISUAL_SENTENCE =
  "Three personalized app screenshots are included in the HTML version of this email.";

// Avoid claiming three finished screens when Stitch assets are unavailable.
export const MONARCH_OUTREACH_NO_VISUAL_BODY_TEMPLATE = `Hi {{business_name}} team,

An industry report found that 73% of med spa patients are repeat customers, highlighting how important it is to keep clients coming back. A branded mobile app can help encourage those repeat visits.

I have an idea for a branded app that could make treatments easier to book and help clients stay connected to {{business_name}} between visits.

If the idea interests you, I can share a more detailed interactive prototype.

${MONARCH_OUTREACH_OPT_OUT_SENTENCE}

Best,
{{sender_name}}
{{signature_company}}

{{postal_address}}`;
