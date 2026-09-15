// ============================================================================
// Populate the MORPHO_BLUE section of data/morpho-type-vaults.json with the
// Feather-indexed vaults on Celo / Sei / Lisk / Soneium / TAC / Hemi / Kaia.
// Append-only: existing vault entries are never removed.
//
// Feather only exposes vault addresses (+ name); the underlying is read
// on-chain in the fetcher, so the resulting dataset is a pure on-chain
// artifact. The Morpho market IDs for these chains already land in
// config/morpho-type-markets.json via the main MorphoBlueUpdater; this job
// fills the vaults list the main pipeline does not populate.
// ============================================================================
import { writeTextIfChanged } from "./io.js";
import { readJsonFile } from "./fetch/utils/index.js";
import { fetchAllFeatherVaults } from "./fetch/morpho/fetchFeatherApi.js";
import { detectVaultVersions } from "./fetch/morpho/vaultVersion.js";
import { dropStubUnderlyings } from "./fetch/morpho/stubUnderlying.js";
const VAULTS_FILE = "./data/morpho-type-vaults.json";
const FORK = "MORPHO_BLUE";
async function main() {
    const vaults = await fetchAllFeatherVaults();
    const totalFetched = Object.values(vaults).reduce((acc, list) => acc + list.length, 0);
    console.log(`Fetched ${totalFetched} Feather vaults across ${Object.keys(vaults).length} chains`);
    let existing = {};
    try {
        existing = readJsonFile(VAULTS_FILE);
    }
    catch {
        existing = {};
    }
    if (!existing[FORK])
        existing[FORK] = {};
    let added = 0;
    let renamed = 0;
    let stubs = 0;
    for (const [chainId, discovered] of Object.entries(vaults)) {
        if (discovered.length === 0)
            continue;
        // Feather indexes the factory smoke-test vault (DummyERC20 underlying)
        // like any other — refuse it before it lands in an append-only file.
        const { kept: infos, dropped } = await dropStubUnderlyings(chainId, discovered);
        stubs += dropped.length;
        if (infos.length === 0)
            continue;
        const current = existing[FORK][chainId] ?? [];
        const known = new Map(current.map((v) => [v.vault.toLowerCase(), v]));
        // Classify each vault as V1 (MetaMorpho) or V2 (Vaults V2) on-chain.
        const addrs = infos.map((i) => i.vault.toLowerCase());
        const versions = await detectVaultVersions(chainId, addrs);
        const versionByAddr = new Map(addrs.map((a, i) => [a, versions[i]]));
        for (const info of infos) {
            const addr = info.vault.toLowerCase();
            const version = versionByAddr.get(addr);
            const entry = known.get(addr);
            if (!entry) {
                known.set(addr, {
                    vault: addr,
                    underlying: info.underlying.toLowerCase(),
                    ...(info.name ? { name: info.name } : {}),
                    ...(version ? { version } : {}),
                });
                added++;
            }
            else {
                if (info.name && entry.name !== info.name) {
                    entry.name = info.name;
                    renamed++;
                }
                if (version && entry.version !== version)
                    entry.version = version;
            }
        }
        existing[FORK][chainId] = Array.from(known.values()).sort((a, b) => a.vault.localeCompare(b.vault));
    }
    const writeResult = await writeTextIfChanged(VAULTS_FILE, JSON.stringify(existing, null, 2) + "\n");
    console.log(`Added ${added} new Feather vaults, refreshed ${renamed} names, refused ${stubs} stub-underlying vault(s); file ${writeResult}.`);
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
