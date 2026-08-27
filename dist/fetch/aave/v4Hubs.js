/**
 * Aave V4 hub seed.
 *
 * Hubs are the entry points the fetcher uses to discover spokes. The
 * `attribution` field is a cosmetic UI hint that gets propagated as
 * `baseHubAttribution` on each spoke entry — it is **not** used for routing
 * or for synthesizing lender keys.
 *
 * Replaces the legacy `config/aave-v4-hubs.json` file (which was deleted
 * because it implied a 1:1 fork↔hub mapping that does not hold on-chain).
 */
export const AAVE_V4_HUB_SEED = {
    '1': [
        {
            hub: '0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9',
            attribution: 'AAVE_V4_CORE',
        },
        {
            hub: '0x06002e9c4412CB7814a791eA3666D905871E536A',
            attribution: 'AAVE_V4_PLUS',
        },
        {
            hub: '0x943827DCA022D0F354a8a8c332dA1e5Eb9F9F931',
            attribution: 'AAVE_V4_PRIME',
        },
    ],
    '10': [
        // ether.fi whitelabel instance — NOT an Aave-operated hub. Its spoke is an
        // `EtherFiSpokeInstance` whose `borrow` is gated on
        // `EtherFiDataProvider.isEtherFiSafe(onBehalfOf)`, and the only position
        // manager ever listed on it is ether.fi's own LendGateway (the stock
        // Giver/Taker/Config PMs and the Native/Signature gateways are
        // deliberately not deployed). Aave's GraphQL API does not know this hub,
        // so the label and peripherals passes find nothing for chain 10.
        {
            hub: '0x66753c4e3fC84f1eD0e3C267C927284E9d90C572',
            attribution: 'AAVE_V4_ETHERFI',
        },
    ],
    '43114': [
        {
            hub: '0xd07369fAE4A5BB13c9Ce446B052c7867B1AbDf6e',
            attribution: 'AAVE_V4_CORE',
        },
    ],
};
