/**
 * Aave V4 oracle discovery.
 *
 * Pure function variant: takes spokes + reserves data, returns oracles + sources.
 */

import { sleep } from '../../utils.js'
import { AAVE_V4_ORACLE_ABI, V4FetchFunctions } from './abiV4.js'
import { multicallRetryUniversal } from '@1delta/providers'
import type { AaveV4SpokesOutput } from './fetchV4Configs.js'
import type { ReservesOutput, ReserveDetailsOutput } from './fetchV4Reserves.js'

/**
 * multicallRetryUniversal maps failed calls to the string "0x" (see @1delta/providers).
 * Number("0x") is NaN and becomes null in JSON — normalize to a safe default.
 */
function normalizeOracleDecimals(raw: unknown): number {
  if (raw === '0x' || raw === undefined || raw === null) return 8
  if (typeof raw === 'bigint') return Number(raw)
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0 && n <= 255) return n
  return 8
}

/** Treat multicall failure / zero address as missing source. */
function normalizeSourceAddress(raw: unknown): string {
  if (raw === '0x' || raw === undefined || raw === null) return ''
  const s = String(raw).toLowerCase()
  if (s === '0x' || s === '0x0000000000000000000000000000000000000000')
    return ''
  return s
}

type OracleEntry = {
  underlying: string
  spoke: string
  reserveId: number
  oracle: string
}

type OracleSourceEntry = {
  underlying: string
  spoke: string
  reserveId: number
  oracle: string
  decimals: number
  source: string
}

type OracleOutput = {
  [fork: string]: {
    [chainId: string]: OracleEntry[]
  }
}

type OracleSourcesOutput = {
  [fork: string]: {
    [chainId: string]: OracleSourceEntry[]
  }
}

export async function fetchAaveV4Oracles(
  spokesData: AaveV4SpokesOutput,
  reservesData: ReservesOutput,
  detailsData: ReserveDetailsOutput,
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
      oracleOutput[fork][chain] = []
      sourcesOutput[fork][chain] = []

      console.log(
        `[${fork}/${chain}] Fetching oracle sources for ${spokes.length} spokes`,
      )

      for (const spokeEntry of spokes) {
        const oracleAddr = spokeEntry.oracle
        const hasOracle =
          !!oracleAddr &&
          oracleAddr !== '' &&
          oracleAddr !== '0x' &&
          oracleAddr !==
            '0x0000000000000000000000000000000000000000'

        if (!hasOracle) {
          console.warn(
            `  [${fork}/${chain}] Spoke ${spokeEntry.spoke} (${spokeEntry.label}): oracle is "${oracleAddr}"`,
          )
        }

        const reserveIds: number[] =
          reservesData[fork]?.[chain]?.[spokeEntry.spoke] ?? []

        if (reserveIds.length === 0) continue

        const reserveDetails =
          detailsData[fork]?.[chain]?.[spokeEntry.spoke] ?? []

        let oracleDecimals = 0
        let sourceResults: any[] = []

        if (hasOracle) {
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

          try {
            const results = (await multicallRetryUniversal({
              chain,
              calls,
              abi: AAVE_V4_ORACLE_ABI,
              allowFailure: true,
            })) as any[]

            oracleDecimals = normalizeOracleDecimals(results[0])
            sourceResults = results.slice(1)

            // Retry only multicall failure sentinels (not on-chain zero address).
            const failedSourceIdx: number[] = []
            for (let si = 0; si < sourceResults.length; si++) {
              if (sourceResults[si] === '0x') failedSourceIdx.push(si)
            }
            if (failedSourceIdx.length > 0) {
              const retryCalls = failedSourceIdx.map((si) => ({
                address: oracleAddr,
                name: V4FetchFunctions.getReserveSource,
                args: [reserveIds[si]],
              }))
              try {
                const retryResults = (await multicallRetryUniversal({
                  chain,
                  calls: retryCalls,
                  abi: AAVE_V4_ORACLE_ABI,
                  allowFailure: true,
                })) as any[]
                for (let j = 0; j < failedSourceIdx.length; j++) {
                  sourceResults[failedSourceIdx[j]] = retryResults[j]
                }
              } catch (retryErr: any) {
                console.error(
                  `  Retry getReserveSource for spoke ${spokeEntry.spoke}: ${retryErr?.message ?? retryErr}`,
                )
              }
              await sleep(250)
            }
          } catch (e: any) {
            console.error(
              `  Error fetching oracle for spoke ${spokeEntry.spoke}: ${e?.message ?? e}`,
            )
          }

          await sleep(250)
        }

        for (let i = 0; i < reserveIds.length; i++) {
          const rid = reserveIds[i]
          const detail = reserveDetails.find(
            (d) => d.reserveId === rid,
          )
          const underlying = detail?.underlying ?? ''
          const source = hasOracle
            ? normalizeSourceAddress(sourceResults[i])
            : ''

          oracleOutput[fork][chain].push({
            underlying,
            spoke: spokeEntry.spoke,
            reserveId: rid,
            oracle: hasOracle ? oracleAddr : '0x',
          })

          sourcesOutput[fork][chain].push({
            underlying,
            spoke: spokeEntry.spoke,
            reserveId: rid,
            oracle: hasOracle ? oracleAddr : '0x',
            decimals: oracleDecimals,
            source,
          })
        }
      }
    }
  }

  console.log('  Written: aave-v4-oracles, aave-v4-oracle-sources')

  return { oracles: oracleOutput, sources: sourcesOutput }
}
