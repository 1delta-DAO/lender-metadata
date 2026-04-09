// Silo v2 ABIs used by the offline scraper.
//
// Only `SiloConfig.getConfig` is needed: pair discovery happens via the
// public Silo frontend API (see `./api.ts`), so we never have to walk
// `SiloFactory.NewSilo` logs or call ERC-20 metadata.
//
// Same shape consumed by `@1delta/margin-fetcher`
// (`packages/margin-fetcher/src/abis/silo-v2/SiloConfig.ts`).

export const SiloConfigAbi = [
  {
    type: "function",
    name: "getConfig",
    stateMutability: "view",
    inputs: [{ name: "_silo", type: "address" }],
    outputs: [
      {
        name: "config",
        type: "tuple",
        components: [
          { name: "daoFee", type: "uint256" },
          { name: "deployerFee", type: "uint256" },
          { name: "silo", type: "address" },
          { name: "token", type: "address" },
          { name: "protectedShareToken", type: "address" },
          { name: "collateralShareToken", type: "address" },
          { name: "debtShareToken", type: "address" },
          { name: "solvencyOracle", type: "address" },
          { name: "maxLtvOracle", type: "address" },
          { name: "interestRateModel", type: "address" },
          { name: "maxLtv", type: "uint256" },
          { name: "lt", type: "uint256" },
          { name: "liquidationTargetLtv", type: "uint256" },
          { name: "liquidationFee", type: "uint256" },
          { name: "flashloanFee", type: "uint256" },
          { name: "hookReceiver", type: "address" },
          { name: "callBeforeQuote", type: "bool" },
        ],
      },
    ],
  },
] as const;
