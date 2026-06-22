import { describe, it, expect } from "vitest";
import { INPUT_HELPER_PY } from "../../src/main/backend/bundledHelpers.js";

describe("INPUT_HELPER_PY pin support", () => {
  it("imports the timeline protocol messages", () => {
    expect(INPUT_HELPER_PY).toContain("WebSocketTimelinePin");
    expect(INPUT_HELPER_PY).toContain("InsertPin");
    expect(INPUT_HELPER_PY).toContain("DeletePin");
  });
  it("handles the pin and unpin verbs", () => {
    expect(INPUT_HELPER_PY).toContain("cmd == 'pin'");
    expect(INPUT_HELPER_PY).toContain("cmd == 'unpin'");
    expect(INPUT_HELPER_PY).toContain("def send_pin");
  });
  it("reports pin/unpin errors on stdout so the ack can resolve", () => {
    expect(INPUT_HELPER_PY).toContain("'screenshot', 'pin', 'unpin'");
  });
});
