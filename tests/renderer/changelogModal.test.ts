import { describe, it, expect } from "vitest";
import { renderChangelogSections } from "../../src/renderer/components/ChangelogModal.js";
import { CHANGELOG } from "../../src/shared/changelog.js";

describe("renderChangelogSections", () => {
  it("produces one section per changelog entry, newest first", () => {
    const secs = renderChangelogSections(CHANGELOG);
    expect(secs.length).toBe(CHANGELOG.length);
    expect(secs[0].version).toBe("3.0.15");
    expect(secs[0].bullets).toEqual(CHANGELOG[0].changes);
  });
});
