import { fileURLToPath } from "node:url";

// Keep this asset in the repository: a Downloads path would not exist on
// another machine running the outbound agent.
export const STITCH_HOME_FRAMEWORK_IMAGE_PATH = fileURLToPath(
  new URL("../../assets/stitch/home-medspa-reference.png", import.meta.url),
);

export const STITCH_BOOKING_FRAMEWORK_IMAGE_PATH = fileURLToPath(
  new URL("../../assets/stitch/booking-medspa-reference.png", import.meta.url),
);

export const STITCH_COMMUNITY_FRAMEWORK_IMAGE_PATH = fileURLToPath(
  new URL("../../assets/stitch/community-medspa-reference.png", import.meta.url),
);

export const STITCH_BLACK_PHONE_PRESENTATION_IMAGE_PATH = fileURLToPath(
  new URL("../../assets/stitch/black-phone-presentation-reference.png", import.meta.url),
);
