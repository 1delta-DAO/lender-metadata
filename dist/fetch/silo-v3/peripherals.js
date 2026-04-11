// Peripheral addresses (factory, lens, router, etc.) for Silo v3 are sourced
// from the official `silo-finance/silo-contracts-v3` repo. Each chain has a
// directory under `silo-core/deployments/<chain>/` (core contracts) and
// `silo-vaults/deployments/<chain>/` (vault contracts). Each file is shaped
// `{ address, abi }` — we only need the address.
//
// This module fetches the relevant JSON files from raw.githubusercontent.com
// for every chain we know, merges the result into a `SiloV3PeripheralsType`,
// and silently skips 404s (not every contract is deployed on every chain).
// Git ref to pull deployments from. `develop` is the active branch — pin to
// a commit SHA here if we ever need reproducible snapshots.
const REF = "develop";
// Maps directory names under `deployments/` to numeric chain ids.
// Keep in sync with the repo layout:
//   https://github.com/silo-finance/silo-contracts-v3/tree/develop/silo-core/deployments
const DEPLOYMENT_DIR_TO_CHAIN_ID = {
    mainnet: "1",
    optimism: "10",
    bnb: "56",
    xdc: "50",
    sonic: "146",
    okx: "196",
    base: "8453",
    arbitrum_one: "42161",
    avalanche: "43114",
    ink: "57073",
};
// (layer, filename) → key on `SiloV3PeripheralsEntry`. Any file that 404s is
// just left undefined on that chain.
const CONTRACT_FILES = [
    { layer: "silo-core", file: "SiloFactory.sol.json", key: "factory" },
    { layer: "silo-core", file: "SiloLens.sol.json", key: "lens" },
    { layer: "silo-core", file: "SiloRouterV2.sol.json", key: "router" },
    {
        layer: "silo-core",
        file: "LeverageRouter.sol.json",
        key: "leverageRouter",
    },
    { layer: "silo-core", file: "SiloDeployer.sol.json", key: "siloDeployer" },
    {
        layer: "silo-core",
        file: "SiloIncentivesControllerFactory.sol.json",
        key: "incentivesControllerFactory",
    },
    { layer: "silo-core", file: "Tower.sol.json", key: "tower" },
    {
        layer: "silo-core",
        file: "DynamicKinkModelFactory.sol.json",
        key: "dynamicKinkModelFactory",
    },
    {
        layer: "silo-core",
        file: "InterestRateModelV2Factory.sol.json",
        key: "interestRateModelV2Factory",
    },
    {
        layer: "silo-vaults",
        file: "SiloVaultsFactory.sol.json",
        key: "vaultsFactory",
    },
    {
        layer: "silo-vaults",
        file: "SiloVaultDeployer.sol.json",
        key: "vaultDeployer",
    },
    {
        layer: "silo-vaults",
        file: "PublicAllocator.sol.json",
        key: "publicAllocator",
    },
    {
        layer: "silo-vaults",
        file: "IdleVaultsFactory.sol.json",
        key: "idleVaultsFactory",
    },
    {
        layer: "silo-vaults",
        file: "SiloIncentivesControllerCLFactory.sol.json",
        key: "incentivesControllerCLFactory",
    },
];
function rawUrl(layer, dir, file) {
    return `https://raw.githubusercontent.com/silo-finance/silo-contracts-v3/${REF}/${layer}/deployments/${dir}/${file}`;
}
async function fetchAddress(url) {
    const res = await fetch(url);
    if (res.status === 404)
        return undefined;
    if (!res.ok) {
        throw new Error(`silo v3 deployments fetch failed: ${res.status} ${url}`);
    }
    const body = (await res.json());
    if (!body.address)
        return undefined;
    return body.address.toLowerCase();
}
/**
 * Pull Silo v3 peripherals from the deployments repo for every chain we
 * know about. Returns a map keyed by numeric chainId.
 */
export async function fetchSiloV3Peripherals() {
    const out = {};
    for (const [dir, chainId] of Object.entries(DEPLOYMENT_DIR_TO_CHAIN_ID)) {
        const entry = {};
        const results = await Promise.all(CONTRACT_FILES.map(async ({ layer, file, key }) => {
            try {
                const address = await fetchAddress(rawUrl(layer, dir, file));
                return { key, address };
            }
            catch (e) {
                console.log(`Silo V3: peripherals fetch error ${dir}/${file}:`, e.message);
                return { key, address: undefined };
            }
        }));
        let anyFound = false;
        for (const { key, address } of results) {
            if (address) {
                entry[key] = address;
                anyFound = true;
            }
        }
        if (anyFound)
            out[chainId] = entry;
    }
    return out;
}
