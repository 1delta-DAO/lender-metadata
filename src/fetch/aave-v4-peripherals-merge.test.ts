import { describe, expect, it } from "vitest";
import {
  mergeAaveV4PeripheralsData,
  mergePositionManagerLists,
} from "./aave/fetchV4Peripherals.js";

describe("mergePositionManagerLists", () => {
  it("merges by address and prefers incoming fields", () => {
    const prev = [
      { name: "Old", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", active: true },
    ];
    const next = [
      { name: "New", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", active: false },
    ];
    const out = mergePositionManagerLists(prev, next);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("New");
    expect(out[0].active).toBe(false);
    expect(out[0].address).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("never lets the API's \"Unknown\" displace a curated PM name", () => {
    // REGRESSION: `update:aave-v4-pm-names` classifies PMs by BYTECODE and
    // writes e.g. "Aave Taker Position Manager"; Aave's GraphQL returns
    // "Unknown" for the same row. A plain incoming-wins merge silently
    // reverted every curated name on each run.
    const addr = "0x6c044c0d3801499bcabfad458b70880bc518e9f7";
    const out = mergePositionManagerLists(
      [{ name: "Aave Taker Position Manager", address: addr, active: true }],
      [{ name: "Unknown", address: addr, active: true }],
    );
    expect(out[0].name).toBe("Aave Taker Position Manager");
  });

  it("still takes a real incoming name", () => {
    const addr = "0x6c044c0d3801499bcabfad458b70880bc518e9f7";
    const out = mergePositionManagerLists(
      [{ name: "Unknown", address: addr, active: true }],
      [{ name: "Aave Native Gateway", address: addr, active: true }],
    );
    expect(out[0].name).toBe("Aave Native Gateway");
  });

  it("sorts by address", () => {
    const out = mergePositionManagerLists(
      [{ name: "b", address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", active: true }],
      [{ name: "a", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", active: true }],
    );
    expect(out[0].address.startsWith("0xaa")).toBe(true);
    expect(out[1].address.startsWith("0xbb")).toBe(true);
  });
});

describe("mergeAaveV4PeripheralsData", () => {
  const CORE_HUB = "0xcca852bc40e560adc3b1cc58ca5b55638ce826c9";

  it("merges the shape the committed config actually has", () => {
    // REGRESSION: this is verbatim the shape of config/aave-v4-peripherals.json
    // (perHub/perSpoke, no `forks` key). The merge used to read `c.forks` and
    // threw `Cannot convert undefined or null to object` on every real run, so
    // the peripherals pass had been dead while its tests — written against the
    // abandoned fork-keyed schema — stayed green.
    const oldData = {
      "1": {
        nativeGateway: "0xe68ab4f90fe026b9873f5f276ed2d7efbbbe42be",
        signatureGateway: "0xfbc184337dc6595d8bf62968bda46e7de7af9c3d",
        perHub: {
          [CORE_HUB]: {
            nativeGateway: "0xe68ab4f90fe026b9873f5f276ed2d7efbbbe42be",
            signatureGateway: "0xfbc184337dc6595d8bf62968bda46e7de7af9c3d",
          },
        },
        perSpoke: {
          "0x3131fe68c4722e726fe6b2819ed68e514395b9a4": {
            spokeName: "Kelp",
            spokeId: "id",
            positionManagers: [],
          },
        },
      },
    };
    const out = mergeAaveV4PeripheralsData(oldData, {});
    expect(out["1"].nativeGateway).toBe("0xe68ab4f90fe026b9873f5f276ed2d7efbbbe42be");
    expect(out["1"].perHub?.[CORE_HUB]?.signatureGateway).toBe(
      "0xfbc184337dc6595d8bf62968bda46e7de7af9c3d",
    );
    expect(out["1"].perSpoke?.["0x3131fe68c4722e726fe6b2819ed68e514395b9a4"]?.spokeName).toBe(
      "Kelp",
    );
  });

  it("keeps prior gateways when incoming are empty", () => {
    const out = mergeAaveV4PeripheralsData(
      {
        "1": {
          nativeGateway: "0xe68ab4f90fe026b9873f5f276ed2d7efbbbe42be",
          signatureGateway: "0xfbc184337dc6595d8bf62968bda46e7de7af9c3d",
          perHub: {},
          perSpoke: {},
        },
      },
      { "1": { nativeGateway: "", signatureGateway: "", perHub: {}, perSpoke: {} } },
    );
    expect(out["1"].nativeGateway).toBe("0xe68ab4f90fe026b9873f5f276ed2d7efbbbe42be");
    expect(out["1"].signatureGateway).toBe("0xfbc184337dc6595d8bf62968bda46e7de7af9c3d");
  });

  it("omits a gateway entirely rather than publishing an empty string", () => {
    // ether.fi's OP instance ships NO native/signature gateway. `""` would read
    // as "there is one and we lost it"; absent is the honest encoding.
    const out = mergeAaveV4PeripheralsData(
      {},
      { "10": { nativeGateway: "", signatureGateway: "", perHub: {}, perSpoke: {} } },
    );
    expect(out["10"]).toBeDefined();
    expect("nativeGateway" in out["10"]).toBe(false);
    expect("signatureGateway" in out["10"]).toBe(false);
  });

  it("merges position managers per spoke without dropping prior addresses", () => {
    const addr = "0x973a023a77420ba610f06b3858ad991df6d85a08";
    const pm = (address: string, name: string) => ({ name, address, active: true });
    const out = mergeAaveV4PeripheralsData(
      {
        "1": {
          perSpoke: {
            [addr]: {
              spokeName: "Bluechip",
              spokeId: "id-old",
              positionManagers: [pm("0x3333333333333333333333333333333333333333", "PM")],
            },
          },
        },
      },
      {
        "1": {
          perSpoke: {
            [addr]: {
              spokeName: "Bluechip",
              spokeId: "id-new",
              positionManagers: [pm("0x4444444444444444444444444444444444444444", "Other")],
            },
          },
        },
      },
    );
    const pms = out["1"].perSpoke?.[addr]?.positionManagers ?? [];
    expect(pms.some((p) => p.address === "0x3333333333333333333333333333333333333333")).toBe(true);
    expect(pms.some((p) => p.address === "0x4444444444444444444444444444444444444444")).toBe(true);
    expect(out["1"].perSpoke?.[addr]?.spokeId).toBe("id-new");
  });

  it("keeps a chain the incoming fetch does not cover at all", () => {
    // Aave's API does not know whitelabel hubs, so chain 10 fetches empty.
    const out = mergeAaveV4PeripheralsData(
      { "10": { perSpoke: { "0xdffcc3536d932eb51df51a7f5fa407c4270d5308": {
        spokeName: "ether.fi Cash", spokeId: "", positionManagers: [] } } } },
      { "1": { nativeGateway: "0xe68ab4f90fe026b9873f5f276ed2d7efbbbe42be" } },
    );
    expect(Object.keys(out)).toEqual(["1", "10"]);
    expect(out["10"].perSpoke?.["0xdffcc3536d932eb51df51a7f5fa407c4270d5308"]?.spokeName).toBe(
      "ether.fi Cash",
    );
  });
});
