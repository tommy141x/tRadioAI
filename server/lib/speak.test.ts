import { describe, expect, it } from "bun:test";
import { sayable } from "./speak";

describe("sayable", () => {
  it("strips markdown a model slipped into spoken text", () => {
    expect(sayable("**LSPD** copy, `10-4`")).toBe("LSPD copy, 10 4");
  });

  it("turns line breaks into a pause", () => {
    expect(sayable("Units responding:\n- 1-Adam-12\n- 2-Boy-4")).toBe(
      "Units responding:, - 1-Adam-12, - 2-Boy-4"
    );
  });

  it("splits ten-codes so a voice does not read the hyphen as a minus", () => {
    expect(sayable("show me 10-8")).toBe("show me 10 8");
    expect(sayable("11-99 traffic")).toBe("11 99 traffic");
  });

  it("leaves callsigns and ranges alone", () => {
    expect(sayable("1-Adam-12 en route, 20-30 minutes")).toBe("1-Adam-12 en route, 20-30 minutes");
  });

  it("keeps a frequency intact", () => {
    expect(sayable("switch to 460.2500")).toBe("switch to 460.2500");
  });

  it("collapses an em dash into a comma", () => {
    expect(sayable("copy — stand by")).toBe("copy, stand by");
  });
});
