import { describe, expect, it } from "vitest";
import { mergeArrayData } from "./aave-v4.js";

describe("mergeArrayData (Aave V4 oracles)", () => {
  it("dedupes rows that differ only by underlying (historical merge key bug)", () => {
    const oldData = {
      FORK: {
        "1": [
          {
            underlying: "",
            spoke: "0xAbC",
            reserveId: 0,
            oracle: "0x1111111111111111111111111111111111111111",
          },
          {
            underlying: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            spoke: "0xabc",
            reserveId: 0,
            oracle: "0x1111111111111111111111111111111111111111",
          },
        ],
      },
    };
    const out = mergeArrayData(oldData, {});
    expect(out.FORK["1"]).toHaveLength(1);
    expect(out.FORK["1"][0].underlying).toBe(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
    expect(out.FORK["1"][0].spoke).toBe("0xabc");
  });

  it("incoming with valid oracle merges fields without wiping known underlying", () => {
    const oldData = {
      FORK: {
        "1": [
          {
            underlying: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            spoke: "0xspoke",
            reserveId: 1,
            oracle: "0x2222222222222222222222222222222222222222",
          },
        ],
      },
    };
    const newData = {
      FORK: {
        "1": [
          {
            underlying: "",
            spoke: "0xspoke",
            reserveId: 1,
            oracle: "0x2222222222222222222222222222222222222222",
          },
        ],
      },
    };
    const out = mergeArrayData(oldData, newData);
    expect(out.FORK["1"]).toHaveLength(1);
    expect(out.FORK["1"][0].underlying).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("incoming with invalid oracle does not replace existing oracle", () => {
    const oldData = {
      FORK: {
        "1": [
          {
            underlying: "0xu",
            spoke: "0xs",
            reserveId: 2,
            oracle: "0x3333333333333333333333333333333333333333",
          },
        ],
      },
    };
    const newData = {
      FORK: {
        "1": [
          {
            underlying: "",
            spoke: "0xs",
            reserveId: 2,
            oracle: "0x0000000000000000000000000000000000000000",
          },
        ],
      },
    };
    const out = mergeArrayData(oldData, newData);
    expect(out.FORK["1"][0].oracle).toBe(
      "0x3333333333333333333333333333333333333333",
    );
  });
});
