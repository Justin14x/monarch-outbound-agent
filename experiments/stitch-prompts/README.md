# Stitch prompt experiments

Use this directory to test prompt ideas without editing the production prompts in `src/config/stitch-prompt.ts` or `src/config/stitch-three-screen-prompts.ts`.

Each experiment is a standalone `.md` file containing **only the exact text to send to Stitch**. Copy a file to try a new version; keep the earlier version so results can be compared. The experiment command creates a new isolated Stitch project and saves returned screenshot PNGs and a manifest locally under `output/stitch-experiments/`. Text-only experiments make one `generate_screen_from_text` call with `deviceType: "MOBILE"`. Experiments using `--reference-image` upload that PNG into the new project and make one `edit_screens` call against the uploaded screen. Neither mode queries or changes Supabase or touches Gmail.

Run the first Skin Hub Home experiment:

```bash
npm run stitch:experiment -- experiments/stitch-prompts/home-no-reference.md --run
```

`--run` is deliberate: generation may consume Stitch credits. Running the command without it only prints the prompt and parameters. A failed or unexpected response is recorded locally and is **not retried** automatically. Results in `output/` are Git-ignored; copy the screenshot URL and findings into this document if you want a durable comparison record.

| Prompt | Purpose | Latest result |
| --- | --- | --- |
| [home-no-reference.md](home-no-reference.md) | One Skin Hub Home screen from website context, no attached image | One screen generated; visual review needed |
| [home-website-only-v2.md](home-website-only-v2.md) | Shorter website-led Home prompt with explicit portrait canvas and no reference image | One screen; landscape canvas and visible quality/claim issues |
| [home-website-only-v3-constraints.md](home-website-only-v3-constraints.md) | Same website-led Home direction with explicit non-negotiable output, layout, navigation, and factual-claim constraints | One screen; clearer navigation, but landscape canvas and unrelated-brand text remain |
| [home-website-only-v4-premium.md](home-website-only-v4-premium.md) | Adds concrete premium art direction for hero imagery, typography, composition, palette, materials, and micro-detail while preserving hard constraints | One screen; stronger photographic hero, but major layout and factual-claim review issues remain |
| [home-medspa-image-reference-v1.md](home-medspa-image-reference-v1.md) | Adapts the user-provided med-spa Home layout while replacing its sample person, appointment, services, photos, and colors for Skin Hub | One edit call returned two resources: one blank canvas and one adapted Home screen; visual QA failed |
| [home-medspa-image-reference-v2-black-phone.md](home-medspa-image-reference-v2-black-phone.md) | Keeps the med-spa layout adaptation while explicitly requiring a complete black outer phone body, bezel, and portrait presentation | One screen with full black phone; approved as the production Home direction, with landscape canvas and a clipped category chip still requiring review |

Preview the new prompt without making a Stitch call:

```bash
npm run stitch:experiment -- experiments/stitch-prompts/home-website-only-v2.md
```

When you explicitly decide to generate a visual test, add `--run` to that same command. It will create a new isolated project and make one generation call, leaving the production prompt and all prospect data unchanged.

For the constraints version, substitute `home-website-only-v3-constraints.md` in the command. Keep each version unchanged after testing so its saved result remains comparable to later experiments.

For the premium-style version, substitute `home-website-only-v4-premium.md`. Its art direction is informed by Apple's guidance on [visual hierarchy](https://developer.apple.com/design/human-interface-guidelines/layout), [consistent color](https://developer.apple.com/design/human-interface-guidelines/color), and using [translucent materials mainly for controls/navigation](https://developer.apple.com/design/human-interface-guidelines/materials), plus the emphasis on cohesive typography and iconography in the [Apple Design Awards](https://developer.apple.com/design/awards/2025/). These are design references, not a guarantee that Stitch will obey every output constraint. The production prompt remains unchanged until a tested result is approved.

Preview the med-spa image-reference prompt and confirm the reference file before making a Stitch call:

```bash
npm run stitch:experiment -- experiments/stitch-prompts/home-medspa-image-reference-v1.md --reference-image "/Users/justinolaleye/Downloads/Warm Spa Wellness Booking App.png"
```

Add `--run` only when ready for one isolated upload-and-edit test. The uploaded image is a project-local Stitch reference, not a Supabase asset. This experiment uses the user-provided Downloads file; if that file moves, update the command path. The approved med-spa image is also copied into the repository as `assets/stitch/home-medspa-reference.png` for production Step 7.

For the black-phone revision, substitute `home-medspa-image-reference-v2-black-phone.md` in the command. The v1 prompt and result remain unchanged for comparison. Neither reference experiment supplies a Supabase logo: Stitch only receives the uploaded layout image, the website URL, and prompt text. The v2 wording and reference image have been promoted to the production Home prompt, but the historical experiment file remains unchanged.

### First Home test — 2026-10-03

- Stitch project: `106338725844258482`
- Screen: `d7c7e52b5e8448eeb5c33f8460f05e5e` — “Skin Hub Med Spa - Mobile App Home Screen”
- Screenshot: [open Stitch image](https://lh3.googleusercontent.com/aida/AEtjO1XA3vyW9loLYKSER9b7S42xY9FPwZm-u2jxVo2IMs7-8V0kwWJnb3UF0uXHuu8UdyHkFrGaLq2CVnVIpOAmizBqQ107JaG3czXIQn8A2QI6qRmbivcLDEM8KjIMm52UiAFHLhwLMnkWGE3W61H1npUe6wBael76DsH4S29CGEbXZUNBD1Mkn-KNHEb7p66vCFDNXztAXgsohvp56-PjHYWWAa5BXX9HvtZ_68eXxVIK-fHzMhzkKuGKxw=w2560)
- Local PNG: `output/stitch-experiments/home-no-reference-iry63g/screen-1-d7c7e52b5e8448eeb5c33f8460f05e5e.png`
- Result: exactly one screen resource, 2560×2048. The full phone is visible, but the overall canvas is landscape despite the requested portrait presentation.
- Review flags: copy appears to imply real-time opening status, a VIP member lounge, complimentary consultations, and a treatment duration. None of those claims was verified by this experiment. Do not use this output in outreach without editing/reviewing it.
- No reference image was uploaded. No production prompt, prospect, Storage object, or Gmail draft was changed.

Do not promote an experiment to production until its visual quality, branding, navigation, device framing, and claims have been reviewed.

### Med-spa black-phone Home test — 2026-10-09

- Prompt: [home-medspa-image-reference-v2-black-phone.md](home-medspa-image-reference-v2-black-phone.md)
- Stitch project: `14405653823162457135`
- Uploaded reference screen: `10847854569761964025`
- One `edit_screens` call returned one screen: `512080df52fb4241a410b26a02c52af1` — “Skin Hub Med Spa - iPhone Home Screen”, 2560×2048. [Open screenshot](https://lh3.googleusercontent.com/aida/AEtjO1VSSUky1oNfhfBaseUIbKpaDz-nGGcjfCrozC_02gbX8RIpypjZgtrbmOOJYeAwerDmWqEU_D-Isv9kUawpOJWf_lt1bX_Hnj8pPl7QoIc3gy8dcwoCEsIISB3brCiEKFROKab11BYS0zJsP5Tc8lquSr3BopbOtaroZHp14a7A4EhUhVY7YqSSIbrFA7qeNeoCY4qZ2GS49V9qeBm4BYZ8Jb7yzqTJjiEsoUFs2Ah8SudwFSFO8TqupCI=w2560).
- Local PNG: `output/stitch-experiments/home-medspa-image-reference-v2-black-phone-i8cmaz/screen-1-512080df52fb4241a410b26a02c52af1.png`.
- Visual review: the complete centered black phone body, thin dark bezel, Dynamic Island, bottom edge, and four-tab navigation are visible. The lower service row is no longer hidden by navigation. However, the overall image canvas is landscape rather than the requested portrait, with large empty side margins. The rightmost category chip is visibly cut off, and the search placeholder ends in an ellipsis. Logo provenance and service-specific copy were not verified by this isolated test.
- No second edit/generation call was made. No production prompt, Supabase prospect, Storage object, or Gmail draft was changed.

### Med-spa image-reference Home test — 2026-10-09

- Prompt: [home-medspa-image-reference-v1.md](home-medspa-image-reference-v1.md)
- Stitch project: `6779349925549428265`
- Uploaded reference screen: `8609651749010898545` (user-provided `Warm Spa Wellness Booking App.png`)
- One `edit_screens` call returned two screen resources, despite requesting exactly one:
  1. `8dc25f942c394743a8eb5634de042a50` — “Skin Hub Med Spa - Mobile Home Screen”, 2560×2048. [Open screenshot](https://lh3.googleusercontent.com/aida/AEtjO1WEi9Oytg1SzE8cAr9S3i0pZEaVUSbK12nv8Bi5PDz7CwBRjd0688zNU9agMbC_fcZiS6t9znyfAa91eA9xGGzIeUt9p8dNBvJoZCDZsuFckYUNV6PjYnJyrGy3IhAZcbOkPHBV1Vextj8tptV7jQRt35qOfL6lgkS1fP_JFd-zLbsS7XWIi-P5S4X6uA35Xp9tPMyfwfTw3pkaWaqgtqxocsZnP5NA6rSvm6VRdwRj7YdBA8H_u16P44s=w2560). The downloaded PNG is a blank light-gray canvas, not an app screen.
  2. `fda6766bceb24d7581c243ff7eda5aa9` — “Skin Hub Med Spa - Native Mobile Home Screen”, 780×1768. [Open screenshot](https://lh3.googleusercontent.com/aida/AEtjO1U3tR4da_29OQKMnlHZMnfEBWOKLPiEOgLF1eD0dDZlkePMrUfb_1idRNUz-5nqylkoftGH9rB7DbvNM0vQ4wCZbKTpCL8PbuLwy7bXQUJgU321mjSnggu6Ztoa1m_DrqvQhQL6_u30HXjPuJnFfwggVIJ7rCXX87mtT5jBu-0GxLpgH9QBQhjNs0KIm9QbzLwkPqlpn3FILvfXOjIIPq1XDv60tEpa2Db8Q8JLY_ystKbXRGHb26hLxMU=w780). The layout follows the reference's header, headline, search, feature card, service discovery, and four-tab navigation, with Skin Hub branding and different photos.
- Visual QA failures on the adapted screen: no complete outer iPhone frame/canvas; the rightmost category chip is cut off; service copy ends in an ellipsis; the lower service row is obscured by the bottom navigation. Business-specific treatment names and claims require source verification before external use.
- Local output: `output/stitch-experiments/home-medspa-image-reference-v1-wq77XU/`.
- No second edit/generation call was made. No production prompt, Supabase prospect, Storage object, or Gmail draft was changed. Do not use either returned image in outreach.

### Fourth Home test — 2026-10-09

- Prompt: [home-website-only-v4-premium.md](home-website-only-v4-premium.md)
- Stitch project: `208158972314274534`
- Screen: `06c9aadfad134b7db7103341c4d0dc36` — “Skin Hub Med Spa Mobile App Home Screen”
- Screenshot: [open Stitch image](https://lh3.googleusercontent.com/aida/AEtjO1U0Z04BC0-AvExjHV1uy5ezM7j0JxHreoODJr3sLfL9AZPLjKXaPDI-iC60-STgDp_49xeRobSN1gW8v2iH8iLl9YvMnW-Zj1I8YfVtJwSikRHPPZDhQd8i-KJgkxh32PgdA2RF5FSbrmToFpKtZSGnywxnXlRi1LO5LAQkz1VcVmA9dYee4wbC0V_yddih0Coe8NQ9lmREn4TuQGtuCt51dqXNjy67oWAl2J1ltQ6a75cmvkB15DZj=w2560)
- Local PNG: `output/stitch-experiments/home-website-only-v4-premium-SUzRY0/screen-1-06c9aadfad134b7db7103341c4d0dc36.png`
- Result: exactly one screen resource, 2560×2048. The complete phone is visible, with a stronger photographic hero and clear four-tab navigation. Stitch again returned a landscape canvas despite the portrait-canvas constraint.
- Review flags: the services rail is cut off at the right edge; lower card content is hidden under the bottom navigation. The screen includes a $99/month membership price, a $10.99/unit Botox perk, virtual consultation, and other specific business claims that were not verified in this experiment. Its composition still relies heavily on ordinary rounded cards. Do not use this output in outreach without review.
- No reference image was uploaded. No production prompt, Supabase prospect, Storage object, or Gmail draft was changed. The first command failed before project creation because sandbox DNS could not resolve Stitch; the successful network-enabled run made one generation call.

### Second Home test — 2026-10-07

- Prompt: [home-website-only-v2.md](home-website-only-v2.md)
- Stitch project: `5009425055351006419`
- Screen: `6b4053de69c94332a9fb7778212b5aaa` — “Skin Hub Med Spa - Mobile App Home Screen”
- Screenshot: [open Stitch image](https://lh3.googleusercontent.com/aida/AEtjO1UUiNHH3dfQy4LcdErHQOTCFzAclK7razNxKgEwgnLaZ0dP8U3AwP8bNZVmr2z_CSH2c9OfgdNsWOJmi8FnBw74X9Zkt4QSwvsSUTYMb_f5MIJhxejysETxFtxa3RLtfbZ_lU7taWFrR9fczzpfVgiHi2uf76sH9mRcm_qsTlyaWE9MfIGleESWnqvD7GjwcYWEFDnaqBODpuKpeHLcEj_g4hdXqd8o27TJM_VGaTjWvvEQmG0F3GTo5w=w2560)
- Local PNG: `output/stitch-experiments/home-website-only-v2-rqS5Yy/screen-1-6b4053de69c94332a9fb7778212b5aaa.png`
- Result: exactly one screen resource, 2560×2048. The full iPhone-style phone is visible, but the surrounding canvas is landscape, ignoring the portrait requirement.
- Review flags: a section is visibly cut off beneath the bottom navigation and faint content appears behind/below it. The screen also claims “Open Today,” “5.0 (Google Verified),” treatment durations, and “Member Fav” without verification in this experiment. These are not approved facts for outreach.
- No reference image was uploaded. No production prompt, Supabase prospect, Storage object, or Gmail draft was changed.

### Third Home test — 2026-10-09

- Prompt: [home-website-only-v3-constraints.md](home-website-only-v3-constraints.md)
- Stitch project: `11427781037666548102`
- Screen: `76c454c5bd8742f783f05cb7bcbe1721` — “Skin Hub Med Spa - Mobile Home Screen Concept”
- Screenshot: [open Stitch image](https://lh3.googleusercontent.com/aida/AEtjO1UYoFTO6mq3R5YiSoyhefqfdYA9QZdAde-jjN9DeWBs1KyL7hxF7s3crCILduDqGs_BQwKleCMXcrGYt4j5PHoXQjqegvFW7keiUniUCaOiQYO0rZJN6B3B5rdbp0qFF-5fZFBrjMxf5lLf1H6QWj3ywbXv94ZdChzZeDXL7vfHdQfKsV5-5CWXHgS3gFsG3Tcylarw-kwFIhoaM3s6rd9wBjuuWMnUjL7lKxNHrD3pRGumZ3mg5TPCq9cD=w2560)
- Local PNG: `output/stitch-experiments/home-website-only-v3-constraints-1N83CK/screen-1-76c454c5bd8742f783f05cb7bcbe1721.png`
- Result: exactly one screen resource, 2560×2048. The phone is complete and its bottom navigation is clearer than v2, but Stitch again ignored the portrait-canvas requirement.
- Review flags: “AURA” appears on signage within the hero photo, introducing an unrelated brand into the Skin Hub concept despite the explicit no-other-business constraint. The screen also includes several specific business details that would need source verification before external use. Do not use this output in outreach.
- No reference image was uploaded. No production prompt, Supabase prospect, Storage object, or Gmail draft was changed.
