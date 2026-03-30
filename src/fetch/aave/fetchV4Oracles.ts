/**
 * Aave V4 oracle discovery.
 *
 * Pure function variant: takes spokes + reserves data, returns oracles + sources.
 */

import { sleep } from '../../utils.js'
import { AAVE_V4_ORACLE_ABI, V4FetchFunctions } from './abiV4.js'
import { multicallRetryUniversal } from '@1delta/providers'
import type { AaveV4SpokesOutput } from './fetchV4Configs.js'
import type { ReservesOutput } from './fetchV4Reserves.js'

type OracleOutput = {
  [fork: string]: {
    [chainId: string]: { [spokeAddr: string]: string }
  }
}

type OracleSourcesOutput = {
  [fork: string]: {
    [chainId: string]: {
      [spokeAddr: string]: {
        oracle: string
        decimals: number
        sources: { [reserveId: string]: string }
      }
    }
  }
}

export async function fetchAaveV4Oracles(
  spokesData: AaveV4SpokesOutput,
  reservesData: ReservesOutput,
): Promise<{
  oracles: OracleOutput
  sources: OracleSourcesOutput
}> {
  const forks = Object.keys(spokesData)
  const oracleOutput: OracleOutput = {}
  const sourcesOutput: OracleSourcesOutput = {}

  for (const fork of forks) {
    oracleOutput[fork] = {}
    sourcesOutput[fork] = {}
    const chainsData = spokesData[fork]

    for (const chain of Object.keys(chainsData)) {
      const spokes = chainsData[chain]
      oracleOutput[fork][chain] = {}
      sourcesOutput[fork][chain] = {}

      console.log(
        `[${fork}/${chain}] Fetching oracle sources for ${spokes.length} spokes`,
      )

      for (const spokeEntry of spokes) {
        const oracleAddr = spokeEntry.oracle
        if (!oracleAddr || oracleAddr === '') continue

        const reserveIds: number[] =
          reservesData[fork]?.[chain]?.[spokeEntry.spoke] ?? []

        if (reserveIds.length === 0) continue

        // Fetch oracle decimals + per-reserve sources
        const calls: any[] = [
          {
            address: oracleAddr,
            name: V4FetchFunctions.decimals,
            args: [],
          },
          ...reserveIds.map((rid) => ({
            address: oracleAddr,
            name: V4FetchFunctions.getReserveSource,
            args: [rid],
          })),
        ]

        let results: any[]
        try {
          results = (await multicallRetryUniversal({
            chain,
            calls,
            abi: AAVE_V4_ORACLE_ABI,
            allowFailure: true,
          })) as any[]
        } catch (e: any) {
          console.error(
            `  Error fetching oracle for spoke ${spokeEntry.spoke}: ${e?.message ?? e}`,
          )
          continue
        }

        await sleep(250)

        const oracleDecimals = Number(results[0] ?? 8)
        const sources: { [reserveId: string]: string } = {}
        for (let i = 0; i < reserveIds.length; i++) {
          sources[reserveIds[i].toString()] = (
            results[i + 1] ?? ''
          )
            .toString()
            .toLowerCase()
        }

        oracleOutput[fork][chain][spokeEntry.spoke] =
          oracleAddr
        sourcesOutput[fork][chain][spokeEntry.spoke] = {
          oracle: oracleAddr,
          decimals: oracleDecimals,
          sources,
        }
      }
    }
  }

  console.log('  Written: aave-v4-oracles, aave-v4-oracle-sources')

  return { oracles: oracleOutput, sources: sourcesOutput }
}
