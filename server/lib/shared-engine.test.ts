import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { aiLog } from "./logger";
import { sharedEngine } from "./shared-engine";

const globals = globalThis as unknown as Record<string, unknown>;
const hadExports = "exports" in globals;
const savedExports = globals.exports;

const FIRST = "http://127.0.0.1:18191/v1/chat/completions";
const SECOND = "http://127.0.0.1:18192/v1/chat/completions";

let advertised = FIRST;
let info: ReturnType<typeof spyOn>;

const advertisement = () =>
  advertised ? JSON.stringify({ resource: "tAI", url: advertised, model: "m" }) : "";

beforeAll(() => {
  globals.exports = {
    tLib: { InferenceLookup: () => advertisement(), InferenceAdvertise: () => "h" },
  };
});

afterAll(() => {
  if (hadExports) globals.exports = savedExports;
  else delete globals.exports;
});

beforeEach(() => {
  advertised = FIRST;
  info = spyOn(aiLog, "info").mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
});

const usingLines = () =>
  info.mock.calls.filter((call: unknown[]) => String(call[0]).includes("shared: using")).length;

describe("sharedEngine", () => {
  test("says which engine it adopted once, not on every lookup", () => {
    for (let i = 0; i < 3; i++) {
      expect(sharedEngine("text-repeat", "some-workload")).toEqual({
        resource: "tAI",
        url: FIRST,
        model: "m",
      });
    }
    expect(usingLines()).toBe(1);
  });

  test("says it again when the advertised address changes", () => {
    sharedEngine("text-change", "some-workload");
    sharedEngine("text-change", "some-workload");
    expect(usingLines()).toBe(1);
    advertised = SECOND;
    expect(sharedEngine("text-change", "some-workload")?.url).toBe(SECOND);
    sharedEngine("text-change", "some-workload");
    expect(usingLines()).toBe(2);
  });

  test("forgets what it said once the advertisement is withdrawn", () => {
    sharedEngine("text-withdrawn", "some-workload");
    expect(usingLines()).toBe(1);
    advertised = "";
    expect(sharedEngine("text-withdrawn", "some-workload")).toBeNull();
    advertised = FIRST;
    expect(sharedEngine("text-withdrawn", "some-workload")?.url).toBe(FIRST);
    expect(usingLines()).toBe(2);
  });
});
