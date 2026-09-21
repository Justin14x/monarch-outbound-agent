import { describe, expect, it } from "vitest";

import { isPrivateNetworkAddress } from "../src/modules/logos/safe-http.js";

describe("logo HTTP network safety", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
  ])("blocks private address %s", (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(true);
  });

  it("allows a public address", () => {
    expect(isPrivateNetworkAddress("8.8.8.8")).toBe(false);
  });
});
