import { describe, it, expect } from "vitest";
import { CHANGELOG } from "../../src/shared/changelog.js";

describe("CHANGELOG", () => {
  it("is non-empty and newest-first (current release leads)", () => {
    // Versioning: the 2.x line is the native-Windows track (no WSL); the 1.x line
    // is the WSL-connected track. 2.0.1 is the first native release and leads.
    expect(CHANGELOG.length).toBeGreaterThan(0);
    expect(CHANGELOG[0].version).toBe("3.0.15");
  });
  it("every entry has a version, a date, and at least one change", () => {
    for (const e of CHANGELOG) {
      expect(e.version).toMatch(/\d/);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.changes.length).toBeGreaterThan(0);
      for (const c of e.changes) expect(c.trim().length).toBeGreaterThan(0);
    }
  });
  it("has no duplicate versions", () => {
    const v = CHANGELOG.map((e) => e.version);
    expect(new Set(v).size).toBe(v.length);
  });
});
