export const STITCH_THREE_SCREEN_ROLES = [
  "Home / Discovery",
  "Services / Booking",
  "Community",
] as const;

export type StitchScreenRole = (typeof STITCH_THREE_SCREEN_ROLES)[number];

export interface UnifiedStitchPromptInput {
  bookingReferenceId: string;
  businessName: string;
  communityReferenceId: string;
  homeReferenceId: string;
  logoReferenceId?: string;
  logoSourceUrl?: string;
  paletteSourceUrl?: string;
  phoneReferenceId: string;
  primaryColor?: string;
  secondaryColor?: string;
  website: string;
}

// One call asks Stitch to design the complete app family together. Layout
// images are deliberately NOT brand authorities: the official website logo
// and color tokens take precedence when they can be verified.
export function renderUnifiedThreeScreenPrompt(input: UnifiedStitchPromptInput): string {
  const logoInstruction = input.logoReferenceId && input.logoSourceUrl
    ? `The official business logo was extracted from ${input.logoSourceUrl} and uploaded to this project as image screen ${input.logoReferenceId}. Use that exact official asset in the app header on all three screens. Preserve its lettering, proportions, internal shapes, and colors. Do not redraw, approximate, invent, or replace the mark. If you cannot reproduce the supplied asset faithfully, use a clean business-name wordmark rather than a fake logo.`
    : `No verified official logo asset is attached. Do not invent or reconstruct a logo. Use the business name as a refined typographic wordmark unless you can confidently use the exact official logo from the business website.`;
  const colorInstruction = input.primaryColor
    ? `The website's verified primary brand color is ${input.primaryColor}${input.secondaryColor ? ` and its secondary/accent color is ${input.secondaryColor}` : ""}${input.paletteSourceUrl ? ` (source: ${input.paletteSourceUrl})` : ""}. Use these actual website colors for the active navigation pill, primary actions, selected controls, and other restrained accents. Do not carry over the example Home image's pale champagne-gold or the Booking image's brown accent when they differ from the business's brand.`
    : `Derive the app's accent colors from the business website and verified logo. The uploaded layout examples are not authoritative sources of brand color; do not copy their sample gold or brown merely because those colors appear in a reference.`;

  return `Generate EXACTLY THREE SEPARATE mobile screen resources for one cohesive native app concept for ${input.businessName}. Business website: ${input.website}.

Create Home / Discovery, Services / Booking, and Community together in this ONE generation request. Return three independent resources in outputComponents[].design.screens, in that order. Do not return a collage, one image containing three phones, a tall combined page, or fewer than three screens.

### REFERENCE ROLES AND BRAND AUTHORITY

Uploaded image screen ${input.homeReferenceId} is the HOME LAYOUT reference and the ONLY authority for the shared bottom navigation. Use its composition and app-shell framework—branded header, editorial headline, search, image-led treatment, service discovery, and especially its four-tab bottom bar. Uploaded image screen ${input.bookingReferenceId} is the BOOKING BODY LAYOUT reference: use its treatment hero, date/time selection, and booking-action arrangement only. Uploaded image screen ${input.communityReferenceId} is the COMMUNITY FEED BODY LAYOUT reference: use its title/intro hierarchy, topic-filter row, image-led post cards, author/comment arrangement, and feed rhythm only. Ignore the Booking and Community images' bottom navigation completely; neither may override or influence the Home reference's navigation. Uploaded image screen ${input.phoneReferenceId} is the PHONE HARDWARE PRESENTATION reference: use ONLY its complete black rounded iPhone body, thin dark bezel, centered Dynamic Island, straight-on view, and narrow neutral canvas margin. Do not copy its app UI, logo, words, photos, or navigation. All four images are layout/presentation examples, not sources of truth for this prospect's logo, exact colors, people, dates, prices, ratings, or text. Never paste a reference image into a new phone.

${logoInstruction}

${colorInstruction}

Use ${input.website} for authentic business-specific services, photography direction, and content. This is a premium sales concept, not a live booking application. Do not present invented prices, ratings, treatment durations, appointment dates or availability, staff identities, medical credentials, customer counts, or promotions as verified business facts. Use clearly conceptual interface copy where a detail is not established by the website.

### UNIFIED PREMIUM DESIGN SYSTEM

Design all three screens together as one high-end, visually rich med-spa consumer app. Use the same typography, color palette, logo/wordmark treatment, icon family, component shapes, border and shadow language, spacing system, photography treatment, phone dimensions, and presentation canvas. Favor controlled whitespace, efficient viewport use, elegant image-led hierarchy, and varied native-mobile compositions over generic cards or empty padding.

The branded top header must use the same logo scale, name treatment, notification icon style, margins, and vertical geometry on every screen. Screen-specific title text may change, but not the header component's visual system.

### LOCKED BOTTOM NAVIGATION — COPY THE HOME REFERENCE

Reproduce the bottom navigation from uploaded Home image screen ${input.homeReferenceId} as ONE locked, reusable four-tab component on ALL THREE generated screens. Match its full-width floating white rounded bar, position above the home indicator, height, outer corner radius, inset margins, subtle depth, and four equal tab slots. Preserve the exact same Home, Booking, Community, Account labels in the same order; preserve each reference icon's shape, stroke weight, size, icon-above-label arrangement, label typography, baseline, and spacing. The selected-tab capsule must keep the Home reference's exact shape, width, height, corner radius, padding, icon/label scale, and vertical alignment. Never enlarge or shrink the selected capsule to fit a longer label such as Community. The unselected tabs, bar, and icon geometry must not change at all between screens.

Across the three screens, the ONLY navigation difference is WHICH tab carries the selected capsule and selected icon/label styling: Home on Screen 1, Booking on Screen 2, Community on Screen 3. Replace the reference's brown selected-tab fill with this prospect's primary website brand color, then use that SAME brand color and SAME selected-state treatment on all three screens. Do not use different selected-pill colors, widths, or shapes by screen. Do not copy the different bottom bar shown in the Community reference. Do not redesign the bar or replace it with a standalone button.

### NON-NEGOTIABLE BLACK PHONE HARDWARE

Present each screen inside the same complete, straight-on modern iPhone-style device shown by presentation reference ${input.phoneReferenceId}. Its continuous BLACK rounded hardware outline and thin dark bezel must be clearly visible on ALL FOUR sides, including the top and bottom edges. Include a centered black Dynamic Island within the screen. Show the entire upright phone on a PORTRAIT neutral canvas; the phone should fill at least 75% of the canvas width and 85% of its height while retaining a narrow margin. Draw ONE consistent thin device shell and reuse its exact outer silhouette on all three screens: identical black rim thickness on every edge, identical corner radii and Dynamic Island, and matching neutral canvas clearance above and below the phone. Aim for a thin black bezel around 2–3% of the phone width and visible top and bottom background margins around 2–3% of the canvas height. Do not make the Booking rim thicker, add a second ring, or let the Community phone touch or be cropped by the top or bottom canvas edge. Match phone scale, bezel thickness, island shape, and canvas dimensions across the three screens. The hardware outline must be truly black, not white, pale gray, or merely a shadow. A raw edge-to-edge UI screenshot is NOT a valid result. Do not return a tiny phone on a wide landscape canvas, perspective mockup, collage, or phone cropped by the canvas.

### SCREEN CONTENT

1. HOME / DISCOVERY — Follow the uploaded Home layout's hierarchy. Show a branded welcome, a confident short headline, search or quick action, one strong image-led featured treatment/booking module, compact service discovery, and the shared four-tab navigation with Home active. Replace every sample name, photo, location, date, and example service with business-appropriate content.
2. SERVICES / BOOKING — Follow the uploaded Booking reference's middle-content layout but keep the shared header and bottom navigation from this same app. Show one website-supported treatment concept, compelling photo, compact date and time selection controls, and a Book Appointment action ABOVE the fixed tab bar. Do not copy the reference's back/share controls, rating, old date, sample price, pale device edge, or bottom-only control. Booking is active.
3. COMMUNITY — Follow the uploaded Community feed reference for the BODY only: a prominent Community title and short introduction, compact topic filters, then an image-led post/feed card with a clear route for customers to ask questions, comment, and receive replies from the business. Preserve the reference's editorial feed hierarchy and visual rhythm, but replace its sample people, photos, post wording, dates, reaction counts, and brown accent. Any example post must be visibly conceptual rather than a claim that real customers have posted. Do not display invented customer names, testimonials, engagement counts, or actual activity. Use the shared branded header and the HOME REFERENCE'S locked bottom navigation with Community selected. Do not turn this into a membership, loyalty, or pricing dashboard.

Keep each screen approximately one mobile viewport in length. Do not clip text, category chips, booking actions, community content, or service rows. Do not let any content sit underneath or behind the fixed bottom bar. The three finished screenshots should be immediately recognizable as different views of the EXACT SAME branded app.`;
}

export const STITCH_PHONE_PRESENTATION = "Present the app UI inside a realistic, front-facing modern iPhone-style device mockup. The complete phone should be visible, including consistent rounded device edges, a thin BLACK bezel, and Dynamic Island at the top. The phone should be centered and shown straight-on with no perspective or rotation. Keep the UI inside the phone portrait-oriented. Match the Home screen's canvas aspect ratio and surrounding margin even if that presentation canvas is wider than it is tall. Use the same device frame, dimensions, proportions, bezel thickness, and presentation style across every generated screen.";

export const STITCH_FINAL_PRESENTATION_QUALITY = `### FINAL PRESENTATION QUALITY

This image will be shown directly to the business as a polished sales concept, so the final render must look presentation-ready.

- Show the entire phone device with comfortable background margin on all four sides. No portion of the phone may touch or extend beyond the canvas.
- Keep the phone centered and straight-on.
- No UI element, text, card, button, chip, navigation item, image, or important content should be accidentally clipped by the screen boundaries.
- Avoid horizontally cut-off category chips or partially visible components.
- Never truncate important visible copy with ellipses. Prefer shorter copy that fits elegantly.
- Keep text concise enough that headings, descriptions, labels, and cards render cleanly.
- Every primary navigation icon should have a clear purpose. Bottom navigation should feel complete and intentionally designed.
- Maintain deliberate spacing and avoid overcrowding simply to fit more content.
- The final screenshot should feel intentionally composed for a portfolio-quality presentation, not like a random screenshot taken from a scrolling application.`;

export const STITCH_CROSS_SCREEN_NAVIGATION_CONSISTENCY = `### CROSS-SCREEN NAVIGATION CONSISTENCY

This screen is part of the same native mobile application as the other generated screens.

The global navigation system must remain visually identical across every screen.

**Bottom navigation:** Use the same four destinations in this order across all screens: Home, Booking, Community, Account. Preserve their icon designs, icon sizes, label typography, spacing, bar height, and background treatment. Only the active destination and its active-state styling may change. Do not introduce a fifth tab or a separate center Book button.

**Top navigation:** Maintain a consistent app-wide header design system, including the same logo treatment, typography family, icon style, sizing, horizontal margins, vertical spacing, and visual language. Screen-specific titles and actions may change when appropriate, but the header must clearly belong to the exact same application.

Do not redesign, reinterpret, or restyle the global navigation from one screen to another. Treat the navigation established by the first approved screen as a locked reusable component.`;

export const STITCH_LIQUID_GLASS_STYLE = `### SHARED MATERIAL LANGUAGE

Treat the generated Home screen as the source of truth for the logo/name container, header controls, cards, and four-tab bottom navigation. Match its surface opacity, edge highlights, corner radii, shadows, and brand accents. If Home uses a subtle frosted or translucent treatment, match that treatment; if it uses solid surfaces, keep them solid. Do not add a new glassmorphism effect that changes the approved Home design.

Only the active tab styling may change. Keep the phone's outer bezel solid black. Preserve legible text and icons, adequate contrast over photography, clear tap targets, and visible business imagery. Do not turn every content card into glass or let heavy blur obscure the app's content.`;

export function renderSharedStitchPrompt(businessName: string, website: string): string {
  return `Create a visually exceptional native mobile app concept for ${businessName}, using ${website} as the primary source of brand inspiration.

This is a premium sales concept, not a production application. You have creative freedom to imagine plausible app functionality and content where useful. Do not present unverified treatment prices, booking availability, review ratings/counts, customer counts, real conversations, event details, medical credentials, or financing terms as facts.

Study the business's website and translate its identity into a sophisticated native mobile product. Incorporate the business's actual logo prominently but tastefully if it can be located on the website, and draw inspiration from its existing colors, photography, typography, services, and overall brand personality. Do not invent or recreate a logo if the official one cannot be located.

### DESIGN QUALITY IS THE HIGHEST PRIORITY

The interface should feel like it was created by an elite mobile product design studio.

Aim for the visual quality of a premium, award-worthy consumer mobile application: luxurious, modern, editorial, highly polished, visually rich, distinctive, and intentionally designed.

Avoid generic SaaS layouts, template-looking UI, excessive cards, repetitive boxes, clutter, or simply recreating the business's website inside a phone. Rich content density is encouraged when visually organized.

Use strong visual hierarchy, sophisticated typography, premium imagery, controlled whitespace, efficient screen utilization, sophisticated visual density, refined spacing, subtle depth, tasteful use of the brand palette, elegant components, and thoughtful visual details.

The design should make the business owner immediately feel that this is a custom, expensive-looking mobile product created specifically for their brand.

### VISUAL DENSITY AND COMPOSITION

The app should feel rich and substantial rather than sparse or overly minimal. Use the available mobile viewport efficiently.

Avoid large empty vertical gaps, oversized padding, excessively tall section spacing, or layouts where only a few simple components occupy the screen.

Create visual richness through layered imagery, compact feature modules, horizontally scrolling content, editorial cards, contextual actions, badges, iconography, overlapping elements, segmented controls, personalized modules, and other sophisticated native mobile patterns where appropriate.

Aim for approximately 5–7 meaningful visual or interactive content moments within the visible viewport while maintaining clear hierarchy and readability.

Prefer varied component sizes and compositions rather than a repetitive vertical stack of equally sized cards.

Do not make every section a simple rectangular card. Full-bleed imagery, image overlays, floating controls, layered surfaces, horizontal carousels, compact feature rows, asymmetric layouts, editorial typography, subtle gradients, contextual badges, and visually connected sections are encouraged.

The interface should immediately communicate that this is a feature-rich custom mobile product, not merely a simplified version of the company's website.

${STITCH_CROSS_SCREEN_NAVIGATION_CONSISTENCY}

${STITCH_LIQUID_GLASS_STYLE}

### PRESENTATION

${STITCH_PHONE_PRESENTATION}

The UI inside the phone should be the visual focus, not the device frame.

${STITCH_FINAL_PRESENTATION_QUALITY}

Create exactly ONE independent native mobile app screen, not a collage or multiple screens. Keep it approximately one mobile viewport (about 390×844 logical pixels), with a visible bottom tab bar. Do not create a long-scrolling webpage or several sections stacked into a tall screenshot.`;
}

export function renderThreeScreenPrompt(options: {
  businessName: string;
  firstScreenReference?: { screenId: string; screenshotUrl: string; width?: number; height?: number };
  previousScreenIds: string[];
  role: StitchScreenRole;
  website: string;
}): string {
  const { businessName, firstScreenReference, previousScreenIds, role, website } = options;
  if (role === "Home / Discovery") {
    return `Edit the selected uploaded Home screen into ONE polished native mobile Home screen for ${businessName}. Business website: ${website}

The uploaded image is a MED-SPA LAYOUT REFERENCE. Use its overall composition and premium visual rhythm, but do not paste the original image into the result or leave its sample content visible. This is an adaptation for ${businessName}, not a pixel-for-pixel copy of the example spa.

### NON-NEGOTIABLE DEVICE PRESENTATION

The final screenshot must show ONE complete, realistic, front-facing iPhone-style DEVICE, not just the app UI cropped to the screen. The entire outer hardware body must be visible: continuous thin BLACK bezel and black rounded phone outline on all four sides, including the top and bottom edges. Keep the Dynamic Island within the phone screen and the home indicator near its bottom. Center the phone upright on a simple light neutral portrait canvas with comfortable empty margin around every side. The phone may not touch or extend beyond the canvas. Do not tilt, rotate, use perspective, or place a second phone behind it.

The uploaded reference has a pale outer device edge. Keep its device dimensions and screen proportions, but change ONLY the outer phone hardware/outline to a clean black finish. Do not replace the hardware outline with a shadow, a white border, or a black background filling the whole canvas. The UI belongs INSIDE the phone screen; do not paste a screenshot of the reference inside another phone mockup.

### LOCKED HOME STRUCTURE

Inside the phone, retain these zones in this order and at approximately the same relative sizes:

1. Compact branded top header with a circular brand mark or official logo treatment on the left, a short welcome, and a notification control on the right.
2. Large, confident two-line editorial headline.
3. Wide rounded search or quick-action bar.
4. Section heading followed by one large image-led featured booking/treatment card with two clear actions.
5. Discovery section with compact category chips and one or two image-led service rows.
6. Fixed rounded bottom navigation with exactly four tabs in this order: Home, Booking, Community, Account. Home is active. Keep all four labels and icons visible.

Preserve the reference's clean hierarchy, section spacing, large feature-card proportions, restrained rounded shapes, soft depth, and clear separation between scrolling content and bottom navigation. Do not add extra sections, a long webpage, or a collage.

### REPLACE THE SAMPLE CONTENT

Replace every example-specific element: the name “Alex,” the person in the header, the appointment date and time, all reference photos, service names, and warm-brown accent colors. Use ${businessName}'s actual business name, website-supported services, official logo if confidently identifiable, and brand-appropriate colors. No logo file is attached separately: do not claim a verified or supplied logo if one cannot be identified from the website. In that case use a refined ${businessName} wordmark instead of inventing a symbol. Choose high-quality med-spa photography that suits ${businessName}; do not reuse the exact photos from the reference image or imply that generic imagery depicts its real staff or location.

The featured card is a BOOKING CONCEPT, not a claim that a customer already has an appointment. It may highlight a website-supported treatment and invite the customer to explore or book. Do not show a fabricated customer identity, booked date, price, discount, rating, medical credential, real event, or specific treatment result. Use short, elegant concept copy when a detail cannot be verified from the website.

### PRESENTATION QUALITY

Make the interface look like a premium, bespoke med-spa consumer app: strong photography, crisp typography, controlled whitespace, subtle layering, cohesive iconography, and a polished brand-derived palette. The design should feel substantial but not crowded. Keep text legible at email-preview size.

Replace source elements cleanly in their existing layout areas. No doubled or ghosted text, leftover example branding, overlapping cards, clipped category chips, truncated primary copy, or content visible behind the bottom navigation. Leave enough safe space above the navigation for the last service row. Return exactly ONE independent screen resource with a usable screenshot and the complete BLACK phone body visible.`;
  }
  const shared = renderSharedStitchPrompt(businessName, website);
  const continuity = previousScreenIds.length > 0
    ? `This is another screen in the SAME Stitch project. Match the existing screen${previousScreenIds.length > 1 ? "s" : ""} (${previousScreenIds.join(", ")}) exactly in typography, colors, navigation, spacing, glass material, and overall design language. Match Screen 1's OUTER PHONE FRAME as well as its app UI: identical device dimensions, proportions, rounded corners, thin black bezel, Dynamic Island, centering, and straight-on presentation. Match the same presentation canvas, including its aspect ratio and empty margins; do not crop the UI to the screen.${firstScreenReference?.width && firstScreenReference.height ? ` Screen 1's screenshot canvas is ${firstScreenReference.width}×${firstScreenReference.height}; use that same canvas shape and scale.` : ""} Reuse Screen 1's header controls and bottom navigation material; do not restyle their translucency, blur, highlights, or shadows. Do not switch to an edge-to-edge screenshot or a different device style.${firstScreenReference ? ` Use Screen 1 (screen ID ${firstScreenReference.screenId}) as the visual reference: ${firstScreenReference.screenshotUrl}` : ""}`
    : "Establish a coherent visual identity and outer phone/device presentation that the next two screens can reuse. Leave enough neutral background around the phone so its complete silhouette is visible.";
  const focus = role === "Services / Booking"
    ? "Screen 2 — Services / Booking: a separate screen for discovering treatments/services and booking an appointment. Use website-supported service categories when available; generic conceptual booking UI is acceptable. The four-tab bottom navigation must match Screen 1's Home navigation exactly in size, position, background, icons, labels, and spacing; only the active tab may change."
    : "Screen 3 — Community: a separate screen where the business owner and team can actively communicate with existing customers. Show a clear way for the business to share updates or announcements and for customers to ask questions, comment, and receive replies. Make this a two-way customer community, not a membership, loyalty, or pricing dashboard. Any sample messages, people, events, or activity must read as concept content rather than verified real-world facts. The four-tab bottom navigation must match Screen 1's Home navigation exactly in size, position, background, icons, labels, and spacing; only the active tab may change.";
  return `${shared}\n\n${continuity}\n\n${focus}`;
}
