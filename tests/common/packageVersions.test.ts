import { describe, expect, it } from "vitest";

import {
  getPackageVersion,
  isPackageInstalled,
} from "../../src/common/packageVersions.js";

describe("Package versions", () => {
  it("Check if package is installed", async () => {
    expect(isPackageInstalled("vitest")).toBe(true);
    expect(isPackageInstalled("nonexistent")).toBe(false);
  });

  it("Get package version", () => {
    expect(getPackageVersion("vitest")).not.toBeNull();
    expect(getPackageVersion("nonexistent")).toBeNull();
  });
});
