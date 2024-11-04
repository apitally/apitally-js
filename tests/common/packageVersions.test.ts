import { describe, expect, it } from "vitest";

import { getPackageVersion } from "../../src/common/packageVersions.js";

describe("Package versions", () => {
  it("Get package version", () => {
    expect(getPackageVersion("vitest")).not.toBeNull();
    expect(getPackageVersion("nonexistent")).toBeNull();
  });
});
