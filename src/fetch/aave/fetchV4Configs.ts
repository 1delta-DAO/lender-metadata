/**
 * Aave V4 config discovery: Hub → Assets → Spokes
 *
 * Starting from a known Hub address, discovers spokes and their oracles.
 * Pure function variant: takes hub seed data, returns configs + spokes.
 */

import { sleep } from '../../utils.js'
import {
  AAVE_V4_HUB_ABI,
  AAVE_V4_SPOKE_ABI,
  V4FetchFunctions,
} from './abiV4.js'
import { multicallRetryUniversal } from '@1delta/providers'

type HubSeedMap = {
  [fork: string]: { [chainId: string]: { hub: string } }
}

export type AaveV4SpokeEntry = {
  spoke: string
  oracle: string
  label: string
  dynamicConfigKeyMax?: number
}

export type AaveV4SpokesOutput = {
  [fork: string]: { [chainId: string]: AaveV4SpokeEntry[] }
}

export async function fetchAaveV4Configs(hubSeed: HubSeedMap): Promise<{
  spokes: AaveV4SpokesOutput
}> {
  const forks = Object.keys(hubSeed)

  const spokesOutput: AaveV4SpokesOutput = {}

  for (const fork of forks) {
    spokesOutput[fork] = {}
    const chainsData = hubSeed[fork]

    for (const chain of Object.keys(chainsData)) {
      const hubAddress = chainsData[chain].hub
      console.log(`[${fork}/${chain}] Discovering from Hub ${hubAddress}`)

      // Step 1: Get asset count
      let assetCount: number
      try {
        const [rawCount] = (await multicallRetryUniversal({
          chain,
          calls: [
            {
              address: hubAddress,
              name: V4FetchFunctions.getAssetCount,
              args: [],
            },
          ],
          abi: AAVE_V4_HUB_ABI,
          allowFailure: false,
        })) as any[]
        assetCount = Number(rawCount)
      } catch (e: any) {
        console.error(
          `  Error getting asset count: ${e?.message ?? e}`,
        )
        continue
      }

      console.log(`  Found ${assetCount} hub assets`)
      await sleep(250)

      if (assetCount === 0) continue

      // Step 2: For each asset, get spoke count
      const spokeCalls = []
      for (let assetId = 0; assetId < assetCount; assetId++) {
        spokeCalls.push({
          address: hubAddress,
          name: V4FetchFunctions.getSpokeCount,
          args: [assetId],
        })
      }

      let spokeCounts: any[]
      try {
        spokeCounts = (await multicallRetryUniversal({
          chain,
          calls: spokeCalls,
          abi: AAVE_V4_HUB_ABI,
          allowFailure: true,
        })) as any[]
      } catch (e: any) {
        console.error(
          `  Error getting spoke counts: ${e?.message ?? e}`,
        )
        continue
      }

      await sleep(250)

      // Step 3: For each asset, enumerate spoke addresses
      const spokeAddrCalls: any[] = []
      const callMeta: { assetId: number; spokeIdx: number }[] = []

      for (let assetId = 0; assetId < assetCount; assetId++) {
        const count = Number(spokeCounts[assetId] ?? 0)
        for (let si = 0; si < count; si++) {
          spokeAddrCalls.push({
            address: hubAddress,
            name: V4FetchFunctions.getSpokeAddress,
            args: [assetId, si],
          })
          callMeta.push({ assetId, spokeIdx: si })
        }
      }

      if (spokeAddrCalls.length === 0) {
        console.log('  No spokes found')
        continue
      }

      let spokeAddrResults: any[]
      try {
        spokeAddrResults = (await multicallRetryUniversal({
          chain,
          calls: spokeAddrCalls,
          abi: AAVE_V4_HUB_ABI,
          allowFailure: true,
        })) as any[]
      } catch (e: any) {
        console.error(
          `  Error getting spoke addresses: ${e?.message ?? e}`,
        )
        continue
      }

      await sleep(250)

      // Deduplicate spoke addresses
      const uniqueSpokes = new Set<string>()
      for (const addr of spokeAddrResults) {
        if (addr && typeof addr === 'string') {
          uniqueSpokes.add(addr.toLowerCase())
        }
      }

      console.log(
        `  Found ${uniqueSpokes.size} unique spokes`,
      )

      // Step 4: For each spoke, get ORACLE()
      const oracleCalls = [...uniqueSpokes].map((spoke) => ({
        address: spoke,
        name: V4FetchFunctions.ORACLE,
        args: [],
      }))

      let oracleResults: any[]
      try {
        oracleResults = (await multicallRetryUniversal({
          chain,
          calls: oracleCalls,
          abi: AAVE_V4_SPOKE_ABI,
          allowFailure: true,
        })) as any[]
      } catch (e: any) {
        console.error(
          `  Error getting oracles: ${e?.message ?? e}`,
        )
        continue
      }

      await sleep(250)

      // Build spoke entries
      const spokeList = [...uniqueSpokes]
      const spokeEntries: AaveV4SpokeEntry[] = spokeList.map(
        (addr, i) => {
          const raw = oracleResults[i]
          const oracle = (raw ?? '').toString().toLowerCase()
          if (
            !oracle ||
            oracle === '0x' ||
            oracle ===
              '0x0000000000000000000000000000000000000000'
          ) {
            console.warn(
              `  [${fork}/${chain}] Spoke ${i} (${addr}): ORACLE() returned empty/zero (raw: ${raw})`,
            )
          }
          return {
            spoke: addr,
            oracle,
            label: `Spoke ${addr.slice(0, 6)}..${addr.slice(-4)}`,
          }
        },
      )

      spokesOutput[fork][chain] = spokeEntries
    }
  }

  console.log('  Written: aave-v4-spokes')

  return { spokes: spokesOutput }
}
