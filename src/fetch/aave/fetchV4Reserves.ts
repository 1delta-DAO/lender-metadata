/**
 * Aave V4 reserves discovery: Spoke → Reserve data
 *
 * Pure function variant: takes spokes data, returns reserves + details.
 */

import { sleep } from '../../utils.js'
import { AAVE_V4_SPOKE_ABI, V4FetchFunctions } from './abiV4.js'
import { multicallRetryUniversal } from '@1delta/providers'
import type { AaveV4SpokeEntry, AaveV4SpokesOutput } from './fetchV4Configs.js'

interface ReserveDetail {
  reserveId: number
  underlying: string
  hub: string
  assetId: number
  decimals: number
  collateralRisk: number
  dynamicConfigKeyMax: number
  borrowable: boolean
  paused: boolean
  frozen: boolean
  latestDynamicConfig: {
    collateralFactor: number
    maxLiquidationBonus: number
    liquidationFee: number
  } | null
}

export type ReservesOutput = {
  [fork: string]: {
    [chainId: string]: { [spokeAddr: string]: number[] }
  }
}

export type ReserveDetailsOutput = {
  [fork: string]: {
    [chainId: string]: {
      [spokeAddr: string]: ReserveDetail[]
    }
  }
}

export type MaxDynamicConfigKeyMap = {
  [fork: string]: {
    [chainId: string]: { [spokeAddr: string]: number }
  }
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

function isEmptyOrZeroAddr(s: string): boolean {
  return !s || s === ZERO_ADDR
}

function needsGetReserveRetry(entry: ReserveDetail): boolean {
  return (
    isEmptyOrZeroAddr(entry.underlying) ||
    isEmptyOrZeroAddr(entry.hub)
  )
}

/** Merge a successful getReserve tuple into an entry (retry pass may partially fill). */
function mergeGetReserveResult(entry: ReserveDetail, result: any): void {
  if (result == null) return
  const isArray = Array.isArray(result)
  const rawU = (isArray ? result[0] : result?.underlying) ?? ''
  const rawH = (isArray ? result[1] : result?.hub) ?? ''
  const u = rawU.toString().toLowerCase()
  const h = rawH.toString().toLowerCase()
  if (u) entry.underlying = u
  if (h) entry.hub = h
  if (u || h) {
    entry.assetId = Number(
      (isArray ? result[2] : result?.assetId) ?? entry.assetId,
    )
    entry.decimals = Number(
      (isArray ? result[3] : result?.decimals) ?? entry.decimals,
    )
    entry.collateralRisk = Number(
      (isArray ? result[4] : result?.collateralRisk) ?? entry.collateralRisk,
    )
    entry.dynamicConfigKeyMax = Number(
      (isArray ? result[6] : result?.dynamicConfigKey) ??
        entry.dynamicConfigKeyMax,
    )
  }
}

/** Extra multicall rounds for getReserve slots that failed inside allowFailure batches. */
const MAX_GET_RESERVE_RETRY_ROUNDS = 2

export async function fetchAaveV4Reserves(spokesData: AaveV4SpokesOutput): Promise<{
  reserves: ReservesOutput
  details: ReserveDetailsOutput
  maxDynamicConfigKeys: MaxDynamicConfigKeyMap
}> {
  const forks = Object.keys(spokesData)

  const reservesOutput: ReservesOutput = {}
  const detailsOutput: ReserveDetailsOutput = {}
  const maxDynKeys: MaxDynamicConfigKeyMap = {}

  for (const fork of forks) {
    reservesOutput[fork] = {}
    detailsOutput[fork] = {}
    maxDynKeys[fork] = {}
    const chainsData = spokesData[fork]

    for (const chain of Object.keys(chainsData)) {
      const spokes = chainsData[chain]
      reservesOutput[fork][chain] = {}
      detailsOutput[fork][chain] = {}
      maxDynKeys[fork][chain] = {}

      console.log(
        `[${fork}/${chain}] Fetching reserves for ${spokes.length} spokes`,
      )

      // Step 1: Get reserve count for all spokes
      const countCalls = spokes.map((s) => ({
        address: s.spoke,
        name: V4FetchFunctions.getReserveCount,
        args: [],
      }))

      let countResults: any[]
      try {
        countResults = (await multicallRetryUniversal({
          chain,
          calls: countCalls,
          abi: AAVE_V4_SPOKE_ABI,
          allowFailure: true,
        })) as any[]
      } catch (e: any) {
        console.error(
          `  Error getting reserve counts: ${e?.message ?? e}`,
        )
        continue
      }

      await sleep(250)

      // Step 2: For each spoke, fetch getReserve(i) and getReserveConfig(i)
      const reserveCalls: any[] = []
      const callMeta: {
        spokeAddr: string
        reserveId: number
        callType: 'reserve' | 'config'
      }[] = []

      for (let si = 0; si < spokes.length; si++) {
        const spokeAddr = spokes[si].spoke
        const count = Number(countResults[si] ?? 0)

        for (let ri = 0; ri < count; ri++) {
          reserveCalls.push({
            address: spokeAddr,
            name: V4FetchFunctions.getReserve,
            args: [ri],
          })
          callMeta.push({
            spokeAddr,
            reserveId: ri,
            callType: 'reserve',
          })

          reserveCalls.push({
            address: spokeAddr,
            name: V4FetchFunctions.getReserveConfig,
            args: [ri],
          })
          callMeta.push({
            spokeAddr,
            reserveId: ri,
            callType: 'config',
          })
        }
      }

      if (reserveCalls.length === 0) {
        console.log('  No reserves found')
        continue
      }

      let reserveResults: any[]
      try {
        reserveResults = (await multicallRetryUniversal({
          chain,
          calls: reserveCalls,
          abi: AAVE_V4_SPOKE_ABI,
          allowFailure: true,
        })) as any[]
      } catch (e: any) {
        console.error(
          `  Error fetching reserve data: ${e?.message ?? e}`,
        )
        continue
      }

      await sleep(250)

      // Parse results
      const spokeReserves: {
        [spokeAddr: string]: ReserveDetail[]
      } = {}

      for (let i = 0; i < callMeta.length; i++) {
        const meta = callMeta[i]
        const result = reserveResults[i]

        if (!spokeReserves[meta.spokeAddr]) {
          spokeReserves[meta.spokeAddr] = []
        }

        if (meta.callType === 'reserve') {
          let entry = spokeReserves[meta.spokeAddr].find(
            (r) => r.reserveId === meta.reserveId,
          )
          if (!entry) {
            entry = {
              reserveId: meta.reserveId,
              underlying: '',
              hub: '',
              assetId: 0,
              decimals: 18,
              collateralRisk: 0,
              dynamicConfigKeyMax: 0,
              borrowable: false,
              paused: false,
              frozen: false,
              latestDynamicConfig: null,
            }
            spokeReserves[meta.spokeAddr].push(entry)
          }

          // multicall may return a named object or a positional array
          const isArray = Array.isArray(result)
          entry.underlying = (
            (isArray ? result[0] : result?.underlying) ?? ''
          ).toString().toLowerCase()
          entry.hub = (
            (isArray ? result[1] : result?.hub) ?? ''
          ).toString().toLowerCase()
          entry.assetId = Number(
            (isArray ? result[2] : result?.assetId) ?? 0,
          )
          entry.decimals = Number(
            (isArray ? result[3] : result?.decimals) ?? 18,
          )
          entry.collateralRisk = Number(
            (isArray ? result[4] : result?.collateralRisk) ?? 0,
          )
          entry.dynamicConfigKeyMax = Number(
            (isArray ? result[6] : result?.dynamicConfigKey) ?? 0,
          )
        } else if (meta.callType === 'config') {
          let entry = spokeReserves[meta.spokeAddr].find(
            (r) => r.reserveId === meta.reserveId,
          )
          if (entry) {
            const isArr = Array.isArray(result)
            entry.borrowable =
              (isArr ? result[3] : result?.borrowable) ?? false
            entry.paused =
              (isArr ? result[1] : result?.paused) ?? false
            entry.frozen =
              (isArr ? result[2] : result?.frozen) ?? false
          }
        }
      }

      for (
        let retryRound = 0;
        retryRound < MAX_GET_RESERVE_RETRY_ROUNDS;
        retryRound++
      ) {
        const retryCalls: any[] = []
        const retryMeta: { spokeAddr: string; reserveId: number }[] = []

        for (const [spokeAddr, details] of Object.entries(spokeReserves)) {
          for (const entry of details) {
            if (!needsGetReserveRetry(entry)) continue
            retryCalls.push({
              address: spokeAddr,
              name: V4FetchFunctions.getReserve,
              args: [entry.reserveId],
            })
            retryMeta.push({ spokeAddr, reserveId: entry.reserveId })
          }
        }

        if (retryCalls.length === 0) break

        console.log(
          `  [${fork}/${chain}] getReserve retry round ${retryRound + 1}/${MAX_GET_RESERVE_RETRY_ROUNDS}: ${retryCalls.length} slot(s)`,
        )

        let retryResults: any[]
        try {
          retryResults = (await multicallRetryUniversal({
            chain,
            calls: retryCalls,
            abi: AAVE_V4_SPOKE_ABI,
            allowFailure: true,
          })) as any[]
        } catch (e: any) {
          console.error(
            `  Error in getReserve retry: ${e?.message ?? e}`,
          )
          break
        }

        await sleep(250)

        for (let i = 0; i < retryMeta.length; i++) {
          const meta = retryMeta[i]
          const result = retryResults[i]
          const entry = spokeReserves[meta.spokeAddr]?.find(
            (r) => r.reserveId === meta.reserveId,
          )
          if (!entry) continue
          mergeGetReserveResult(entry, result)
        }
      }

      // Step 3: Fetch getDynamicReserveConfig(reserveId, latestKey) for each reserve
      const dynCalls: any[] = []
      const dynMeta: { spokeAddr: string; reserveId: number }[] = []

      for (const [spokeAddr, details] of Object.entries(spokeReserves)) {
        for (const entry of details) {
          dynCalls.push({
            address: spokeAddr,
            name: V4FetchFunctions.getDynamicReserveConfig,
            args: [entry.reserveId, entry.dynamicConfigKeyMax],
          })
          dynMeta.push({ spokeAddr, reserveId: entry.reserveId })
        }
      }

      if (dynCalls.length > 0) {
        let dynResults: any[]
        try {
          dynResults = (await multicallRetryUniversal({
            chain,
            calls: dynCalls,
            abi: AAVE_V4_SPOKE_ABI,
            allowFailure: true,
          })) as any[]

          for (let i = 0; i < dynMeta.length; i++) {
            const dm = dynMeta[i]
            const result = dynResults[i]
            const entry = spokeReserves[dm.spokeAddr]?.find(
              (r) => r.reserveId === dm.reserveId,
            )
            if (entry && result) {
              const isArr = Array.isArray(result)
              entry.latestDynamicConfig = {
                collateralFactor: Number(
                  (isArr ? result[0] : result?.collateralFactor) ?? 0,
                ),
                maxLiquidationBonus: Number(
                  (isArr ? result[1] : result?.maxLiquidationBonus) ?? 0,
                ),
                liquidationFee: Number(
                  (isArr ? result[2] : result?.liquidationFee) ?? 0,
                ),
              }
            }
          }
        } catch (e: any) {
          console.error(
            `  Error fetching dynamic configs: ${e?.message ?? e}`,
          )
        }

        await sleep(250)
      }

      // Build output
      for (const [spokeAddr, details] of Object.entries(
        spokeReserves,
      )) {
        reservesOutput[fork][chain][spokeAddr] =
          details.map((d) => d.reserveId)
        detailsOutput[fork][chain][spokeAddr] = details
        maxDynKeys[fork][chain][spokeAddr] = details.reduce(
          (max, d) => Math.max(max, d.dynamicConfigKeyMax), 0,
        )
      }

      const totalReserves = Object.values(
        reservesOutput[fork][chain],
      ).reduce((sum, arr) => sum + arr.length, 0)
      console.log(
        `  Found ${totalReserves} total reserves across ${Object.keys(reservesOutput[fork][chain]).length} spokes`,
      )
    }
  }

  console.log('  Written: aave-v4-reserves, aave-v4-reserve-details')

  return { reserves: reservesOutput, details: detailsOutput, maxDynamicConfigKeys: maxDynKeys }
}
