import { describe, expect, it } from "vitest";
import { entityKey } from "../src/lib/types";

describe("entityKey", () => {
  it("lowercases the label and the normalized name", () => {
    expect(entityKey("Kestrel Labs", "Tool")).toBe("tool::kestrel labs");
  });

  it("normalizes whitespace and label casing to the same key", () => {
    expect(entityKey("  Kestrel   Labs  ", "TOOL")).toBe(entityKey("Kestrel Labs", "Tool"));
  });
});
