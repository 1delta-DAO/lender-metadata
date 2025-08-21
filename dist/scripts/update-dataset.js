import { sha256Hex } from "#lib/hash";
import { writeTextIfChanged } from "#lib/io";
const query = (first, skip, chainId) => `
query GetMarkets {
  markets(first: ${first}, skip: ${skip}, where:  {
     chainId_in: [${chainId}],
     whitelisted: true
  },
  orderBy: SupplyAssetsUsd,   
  orderDirection: Desc
  ) {
    items {
      uniqueKey
      lltv
      loanAsset {
        symbol
      }
      collateralAsset {
        symbol
      }
    }
  }
}
`;
const BASE_URL = "https://blue-api.morpho.org/graphql";
async function fetchMorphoMarkets(chainId) {
    const requestBody = {
        query: query(200, 0, chainId),
        variables: {},
    };
    const response = await fetch(BASE_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
        throw new Error(`Network error: ${response.status} - ${response.statusText}`);
    }
    const data = await response.json();
    return data.data;
}
// function toSuperscriptDigits(num: number | string): string {
//   const map: Record<string, string> = {
//     "0": "⁰",
//     "1": "¹",
//     "2": "²",
//     "3": "³",
//     "4": "⁴",
//     "5": "⁵",
//     "6": "⁶",
//     "7": "⁷",
//     "8": "⁸",
//     "9": "⁹",
//   };
//   return num
//     .toString()
//     .split("")
//     .map((char) => map[char] || "")
//     .join("");
// }
function numberToBpsSuperscript(input) {
    const bps = Math.round(parseFloat(input.toString()) * 100); // e.g. 94.5 → 9450
    return bps.toString(); // toSuperscriptDigits(bps);
}
async function getEnums() {
    const chainid = "1";
    const mbData = await fetchMorphoMarkets(chainid);
    const arr = mbData.markets.items;
    let namesMap = {};
    let shortNamesMap = {};
    for (const el of arr) {
        const hash = el.uniqueKey;
        const enumName = `MORPHO_BLUE_${hash.slice(2).toUpperCase()}`;
        if (el.loanAsset?.symbol && el.collateralAsset?.symbol) {
            const nameEnum = `${"Morpho " +
                el.collateralAsset.symbol +
                "-" +
                el.loanAsset.symbol +
                " " +
                numberToBpsSuperscript((Number(el.lltv) / 1e18) * 100)}`;
            const nameEnumShort = `${"MB " +
                el.collateralAsset.symbol +
                "-" +
                el.loanAsset.symbol +
                " " +
                numberToBpsSuperscript((Number(el.lltv) / 1e18) * 100)}`;
            namesMap[enumName] = nameEnum;
            shortNamesMap[enumName] = nameEnumShort;
        }
    }
    return { names: namesMap, shortNames: shortNamesMap };
}
async function fetchUpstream() {
    return getEnums();
}
async function main() {
    const data = await fetchUpstream();
    // Serialize and derive a stable content hash
    const payload = JSON.stringify(data, null, 2) + "\n";
    const sha = sha256Hex(payload);
    const manifest = {
        version: sha.slice(0, 12),
        generatedAt: new Date().toISOString(),
        sha256: sha,
    };
    const wroteData = await writeTextIfChanged("data/latest.json", payload);
    const wroteManifest = await writeTextIfChanged("data/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    if (wroteData === "skipped" && wroteManifest === "skipped") {
        console.log("No changes in dataset.");
    }
    else {
        console.log("Dataset updated:", manifest);
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
