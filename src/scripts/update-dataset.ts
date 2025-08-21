import { StoredData } from "#lib/schema";
import { sha256Hex } from "#lib/hash";
import { readTextIfExists, writeTextIfChanged } from "#lib/io";

const query = (first: number, skip: number, chainId: string) => `
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

async function fetchMorphoMarkets(chainId: string) {
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
    throw new Error(
      `Network error: ${response.status} - ${response.statusText}`
    );
  }

  const data: any = await response.json();

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

/** Load existing file if present; otherwise return empty structure */
async function loadExisting(path = "data/latest.json"): Promise<StoredData> {
  const raw = await readTextIfExists(path);
  if (!raw) return { names: {}, shortNames: {} };
  // Be liberal in what we accept; validate shape, but default missing maps.
  const parsed = JSON.parse(raw);
  return {
    names: parsed.names ?? {},
    shortNames: parsed.shortNames ?? {},
  };
}

function numberToBps(input: number | string): string {
  const bps = Math.round(parseFloat(input.toString()) * 100); // e.g. 94.5 → 9450
  return bps.toString(); // toSuperscriptDigits(bps);
}

/** Build fresh data from upstream only (no merging here) */
async function buildIncoming(): Promise<StoredData> {
  const chainids = ["1", "8453", "137", "42161"];
  const mbData = await Promise.all(
    chainids.map((id) => fetchMorphoMarkets(id))
  );

  const items = mbData.flatMap((b) => b.markets.items ?? []);

  const names: Record<string, string> = {};
  const shortNames: Record<string, string> = {};

  for (const el of items) {
    const hash: string = el.uniqueKey;
    const enumName = `MORPHO_BLUE_${hash.slice(2).toUpperCase()}`;

    const loanSym = el.loanAsset?.symbol;
    const collSym = el.collateralAsset?.symbol;
    if (!loanSym || !collSym) continue;

    const bps = numberToBps(el.lltv);

    const longName = `Morpho ${collSym}-${loanSym} ${bps}`;
    const shortName = `MB ${collSym}-${loanSym} ${bps}`;

    names[enumName] = longName;
    shortNames[enumName] = shortName;
  }

  return { names, shortNames };
}

/** Append-only merge: keep existing manual edits; only add NEW keys from incoming */
function appendOnlyMerge(
  existing: StoredData,
  incoming: StoredData
): { merged: StoredData; added: number } {
  const mergedNames = { ...existing.names };
  const mergedShort = { ...existing.shortNames };

  let added = 0;

  for (const [k, v] of Object.entries(incoming.names)) {
    if (!(k in mergedNames)) {
      mergedNames[k] = v; // add new key
      added++;
    }
    // else: do NOT overwrite existing manual value
  }
  for (const [k, v] of Object.entries(incoming.shortNames)) {
    if (!(k in mergedShort)) {
      mergedShort[k] = v; // add new key
    }
    // else: do NOT overwrite existing manual value
  }

  // Optional: make diffs stable by sorting keys
  const sortRec = (rec: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(rec).sort(([a], [b]) => a.localeCompare(b))
    );

  return {
    merged: { names: sortRec(mergedNames), shortNames: sortRec(mergedShort) },
    added,
  };
}

// async function fetchUpstream(): Promise<unknown> {
//   return getEnums();
// }

async function main(): Promise<void> {
  // 1) Build fresh incoming from upstream
  const incoming = await buildIncoming();

  // 2) Load existing stored data (manual edits live here)
  const existing = await loadExisting("data/latest.json");

  // 3) Append-only merge (manual edits win)
  const { merged, added } = appendOnlyMerge(existing, incoming);

  // 4) Serialize and write if changed
  const payload = JSON.stringify(merged, null, 2) + "\n";
  const sha = sha256Hex(payload);
  const manifest = {
    version: sha.slice(0, 12),
    generatedAt: new Date().toISOString(),
    sha256: sha,
    added, // for logs/inspection
  };

  const wroteData = await writeTextIfChanged("data/latest.json", payload);
  const wroteManifest = await writeTextIfChanged(
    "data/manifest.json",
    JSON.stringify(manifest, null, 2) + "\n"
  );

  if (wroteData === "skipped" && wroteManifest === "skipped") {
    console.log("No changes (append-only, added=0).");
  } else {
    console.log("Dataset updated (append-only):", manifest);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
