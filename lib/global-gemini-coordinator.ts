import 'server-only'

import {
  apiKeyHash,
  getModelUsage,
  setModelExhausted,
  isModelDailyQuotaExhausted,
  geminiUsageDay,
  checkDailyReset,
} from './store'
import { RATE_COOLDOWN_MS, CHUNK_COOLDOWN_MS } from './models'

export interface CandidateLane {
  apiKey: string
  keyIdx: number
  modelId: string
  slot?: number
  rpd?: number
}

interface Waiter<TRelease = (cooldownOverrideMs?: number) => void> {
  id: string
  scanId: string
  scanTitle: string
  operation: string
  resolve: (releaseFn: TRelease) => void
  reject: (err: Error) => void
  isStopping?: () => boolean
}

/** State for Heavy Requests: Chunks & Rescans (~190,000 tokens) */
interface ChunkGateState {
  kmKey: string
  keyHash: string
  keyIdx: number
  modelId: string
  activeScanId: string | null
  activeScanTitle: string | null
  activeOperation: string | null
  activeSince: number | null
  cooldownUntil: number
  isExhausted: boolean
  waiters: Waiter<(actualVideoSec?: number, cooldownOverrideMs?: number) => void>[]
  dispatchTimer: NodeJS.Timeout | null
}

/** State for Light Requests: Candidate Verifications (~5,000–15,000 tokens, 2–4s clips) */
interface VerifierGateState {
  kmKey: string
  keyHash: string
  keyIdx: number
  modelId: string
  activeScanId: string | null
  activeScanTitle: string | null
  activeOperation: string | null
  activeSince: number | null
  cooldownUntil: number
  nextFreeAt: number
  isExhausted: boolean
  waiters: Waiter<(actualVideoSec?: number, cooldownOverrideMs?: number) => void>[]
  dispatchTimer: NodeJS.Timeout | null
}

class GlobalGeminiCoordinator {
  private currentActiveDay = geminiUsageDay()

  // DEDICATED INDEPENDENT GATES (Per API Key × Model):
  // 1. chunkGates: Chunks & Rescans (~190,000 tokens) - 70s TPM cooldown, max 1 active per (key × model).
  // 2. verifierGates: Candidate Verifiers (~5,000–15,000 tokens) - 3s pacing, 60s cooldown on 429, max 1 active per (key × model).
  private chunkGates = new Map<string, ChunkGateState>()
  private verifierGates = new Map<string, VerifierGateState>()

  // Consecutive error counter per (key × model)
  private consecutiveErrors = new Map<string, number>()

  public checkDayRollover(): boolean {
    const today = geminiUsageDay()
    if (today !== this.currentActiveDay) {
      console.log(`[Global Coordinator] Daily quota rollover detected (${this.currentActiveDay} -> ${today}). Resetting all gates!`)
      this.currentActiveDay = today
      for (const cg of this.chunkGates.values()) {
        cg.isExhausted = false
        cg.cooldownUntil = 0
      }
      for (const vg of this.verifierGates.values()) {
        vg.isExhausted = false
        vg.cooldownUntil = 0
        vg.nextFreeAt = 0
      }
      checkDailyReset()
      return true
    }
    return false
  }

  private getModelKey(apiKey: string, modelId: string): string {
    return `${apiKeyHash(apiKey)}:${modelId}`
  }

  private getOrCreateChunkGate(apiKey: string, modelId: string, keyIdx: number = 1): ChunkGateState {
    const kmKey = this.getModelKey(apiKey, modelId)
    let gate = this.chunkGates.get(kmKey)
    if (!gate) {
      gate = {
        kmKey,
        keyHash: apiKeyHash(apiKey),
        keyIdx,
        modelId,
        activeScanId: null,
        activeScanTitle: null,
        activeOperation: null,
        activeSince: null,
        cooldownUntil: 0,
        isExhausted: false,
        waiters: [],
        dispatchTimer: null,
      }
      this.chunkGates.set(kmKey, gate)
    }
    if (keyIdx > 0) gate.keyIdx = keyIdx
    return gate
  }

  private getOrCreateVerifierGate(apiKey: string, modelId: string, keyIdx: number = 1): VerifierGateState {
    const kmKey = this.getModelKey(apiKey, modelId)
    let gate = this.verifierGates.get(kmKey)
    if (!gate) {
      gate = {
        kmKey,
        keyHash: apiKeyHash(apiKey),
        keyIdx,
        modelId,
        activeScanId: null,
        activeScanTitle: null,
        activeOperation: null,
        activeSince: null,
        cooldownUntil: 0,
        nextFreeAt: 0,
        isExhausted: false,
        waiters: [],
        dispatchTimer: null,
      }
      this.verifierGates.set(kmKey, gate)
    }
    if (keyIdx > 0) gate.keyIdx = keyIdx
    return gate
  }

  /**
   * Instant, zero-wait quota check:
   * Verifies if a model on a given API key has exhausted its daily quota (RPD).
   */
  public isModelExhausted(apiKey: string, modelId: string, rpdCap: number = 500): boolean {
    this.checkDayRollover()
    const kmKey = this.getModelKey(apiKey, modelId)
    const exhaustedInStore = isModelDailyQuotaExhausted(modelId, apiKey, rpdCap)
    const cg = this.chunkGates.get(kmKey)
    const vg = this.verifierGates.get(kmKey)
    if (cg) cg.isExhausted = exhaustedInStore
    if (vg) vg.isExhausted = exhaustedInStore
    return exhaustedInStore
  }

  // =========================================================================
  // GATE 1: CHUNK & RESCAN COORDINATOR (Heavy Requests: ~190,000 tokens)
  // =========================================================================

  /**
   * Check before sending a Chunk / Rescan request:
   * Checks if ANY scan is currently running a heavy request on this (key × model),
   * if it is in 70s TPM cooldown, or if it is daily exhausted.
   */
  public canAcquireChunk(
    apiKey: string,
    modelId: string,
    rpdCap: number = 20,
    keyIdx: number = 1,
  ): {
    available: boolean
    busy: boolean
    exhausted?: boolean
    cooling?: boolean
    waitSec?: number
    activeScanId?: string
    activeOperation?: string
  } {
    this.checkDayRollover()
    const gate = this.getOrCreateChunkGate(apiKey, modelId, keyIdx)
    const now = Date.now()

    const exhausted = isModelDailyQuotaExhausted(modelId, apiKey, rpdCap)
    gate.isExhausted = exhausted
    if (exhausted) {
      return { available: false, busy: true, exhausted: true }
    }

    if (gate.activeScanId !== null) {
      return {
        available: false,
        busy: true,
        activeScanId: gate.activeScanId,
        activeOperation: gate.activeOperation || 'Chunk mapping',
      }
    }

    if (gate.cooldownUntil > now) {
      return {
        available: false,
        busy: true,
        cooling: true,
        waitSec: Math.ceil((gate.cooldownUntil - now) / 1000),
      }
    }

    if (gate.waiters.length > 0) {
      return {
        available: false,
        busy: true,
        waitSec: 2,
      }
    }

    return { available: true, busy: false }
  }

  /**
   * Atomic Non-blocking Acquisition for Chunk scanning:
   * If free, locks the model immediately and returns release. If busy/cooling, returns null.
   */
  public tryAcquireChunk(opts: {
    scanId: string
    scanTitle?: string
    apiKey: string
    keyIdx?: number
    modelId: string
    operation: string
    rpd?: number
  }): { release: (actualVideoSec?: number, cooldownOverrideMs?: number) => void } | null {
    const { scanId, scanTitle = scanId, apiKey, keyIdx = 1, modelId, operation, rpd = 20 } = opts
    const check = this.canAcquireChunk(apiKey, modelId, rpd, keyIdx)
    if (!check.available) return null

    const gate = this.getOrCreateChunkGate(apiKey, modelId, keyIdx)
    gate.activeScanId = scanId
    gate.activeScanTitle = scanTitle
    gate.activeOperation = operation
    gate.activeSince = Date.now()

    const release = (actualVideoSec?: number, cooldownOverrideMs?: number) => {
      this.releaseChunk(gate, actualVideoSec ?? 60, cooldownOverrideMs)
    }

    return { release }
  }

  /**
   * Acquire lock for Chunk / Rescan with Anti-Thundering-Herd FIFO queue.
   */
  public async acquireChunk(opts: {
    scanId: string
    scanTitle?: string
    apiKey: string
    keyIdx?: number
    modelId: string
    operation: string
    videoSeconds?: number
    rpd?: number
    onWait?: (msg: string, waitSec: number) => void
    isStopping?: () => boolean
  }): Promise<(actualVideoSec?: number, cooldownOverrideMs?: number) => void> {
    const {
      scanId,
      scanTitle = scanId,
      apiKey,
      keyIdx = 1,
      modelId,
      operation,
      videoSeconds = 60,
      rpd = 20,
      onWait,
      isStopping,
    } = opts

    this.checkDayRollover()
    const gate = this.getOrCreateChunkGate(apiKey, modelId, keyIdx)

    return new Promise((resolve, reject) => {
      const now = Date.now()
      const isFree =
        !gate.isExhausted &&
        !isModelDailyQuotaExhausted(modelId, apiKey, rpd) &&
        gate.activeScanId === null &&
        gate.cooldownUntil <= now &&
        gate.waiters.length === 0

      if (isFree) {
        // Grab lock atomically
        gate.activeScanId = scanId
        gate.activeScanTitle = scanTitle
        gate.activeOperation = operation
        gate.activeSince = now

        const release = (actualVideoSec?: number, cooldownOverrideMs?: number) => {
          this.releaseChunk(gate, actualVideoSec ?? videoSeconds, cooldownOverrideMs)
        }
        resolve(release)
        return
      }

      // Model is currently busy or cooling down:
      const waitSec = gate.cooldownUntil > now ? Math.ceil((gate.cooldownUntil - now) / 1000) : 5
      const waitMsg = gate.activeScanId
        ? `[Global Coordinator] Key ${gate.keyIdx} · ${modelId} is busy in Scan "${gate.activeScanTitle || gate.activeScanId}". Queued behind active scan...`
        : `[Global Coordinator] Key ${gate.keyIdx} · ${modelId} in 70s TPM cooldown (${waitSec}s remaining). Queued...`
      onWait?.(waitMsg, waitSec)

      // Add to FIFO queue
      gate.waiters.push({
        id: Math.random().toString(36).substring(2, 9),
        scanId,
        scanTitle,
        operation,
        resolve,
        reject,
        isStopping,
      })

      // Ensure anti-thundering-herd dispatcher is scheduled
      const delayMs = Math.max(1000, gate.cooldownUntil > now ? gate.cooldownUntil - now + 50 : 2000)
      this.scheduleChunkDispatch(gate, delayMs)
    })
  }

  private scheduleChunkDispatch(gate: ChunkGateState, delayMs: number) {
    if (gate.dispatchTimer) {
      clearTimeout(gate.dispatchTimer)
      gate.dispatchTimer = null
    }
    gate.dispatchTimer = setTimeout(() => {
      gate.dispatchTimer = null
      this.dispatchNextChunk(gate)
    }, Math.max(10, delayMs))
  }

  /**
   * ANTI-THUNDERING-HERD DISPATCHER (Chunks & Rescans):
   * When cooldown ends, pops and grants the lock to ONLY THE FIRST WAITER.
   * Other parallel scans stay queued so they never hit Google at the same millisecond!
   */
  private dispatchNextChunk(gate: ChunkGateState) {
    const now = Date.now()
    if (gate.activeScanId !== null) return

    if (gate.cooldownUntil > now) {
      this.scheduleChunkDispatch(gate, gate.cooldownUntil - now + 50)
      return
    }

    while (gate.waiters.length > 0) {
      const next = gate.waiters.shift()!
      if (next.isStopping && next.isStopping()) {
        next.reject(new Error('Stop requested while queued in chunk coordinator'))
        continue
      }

      // ATOMIC LOCK ACQUISITION:
      // Mark as active immediately BEFORE resolving next!
      // This guarantees no other scan or waiter can sneak in at the exact same millisecond.
      gate.activeScanId = next.scanId
      gate.activeScanTitle = next.scanTitle
      gate.activeOperation = next.operation
      gate.activeSince = Date.now()

      const releaseFn = (actualVideoSec?: number, cooldownOverrideMs?: number) => {
        this.releaseChunk(gate, actualVideoSec ?? 60, cooldownOverrideMs)
      }

      next.resolve(releaseFn)
      return // ONLY ONE WAITER RESOLVED!
    }
  }

  private releaseChunk(gate: ChunkGateState, videoSeconds: number, cooldownOverrideMs?: number) {
    const now = Date.now()
    gate.activeScanId = null
    gate.activeScanTitle = null
    gate.activeOperation = null
    gate.activeSince = null

    // 70s TPM Cooldown for heavy requests (~190,000 tokens)
    const coolMs = cooldownOverrideMs !== undefined ? cooldownOverrideMs : CHUNK_COOLDOWN_MS
    if (coolMs > 0) {
      gate.cooldownUntil = Math.max(gate.cooldownUntil, now + coolMs)
      this.scheduleChunkDispatch(gate, coolMs + 50)
    } else if (gate.waiters.length > 0) {
      this.scheduleChunkDispatch(gate, 50)
    }
  }

  // =========================================================================
  // GATE 2: VERIFIER COORDINATOR (Light Requests: ~5,000–15,000 tokens, 2–4s clips)
  // =========================================================================

  /**
   * Check before sending a Verifier request:
   * Checks if ANY scan is currently running a verifier request on this (key × model),
   * if it is in verifier cooldown (429), or if it is currently in the 3s pacing delay.
   */
  public canAcquireVerifier(
    apiKey: string,
    modelId: string,
    rpdCap: number = 500,
    keyIdx: number = 1,
  ): {
    available: boolean
    busy: boolean
    exhausted?: boolean
    cooling?: boolean
    waitSec?: number
    activeScanId?: string
    activeOperation?: string
  } {
    this.checkDayRollover()
    const gate = this.getOrCreateVerifierGate(apiKey, modelId, keyIdx)
    const now = Date.now()

    const exhausted = isModelDailyQuotaExhausted(modelId, apiKey, rpdCap)
    gate.isExhausted = exhausted
    if (exhausted) {
      return { available: false, busy: true, exhausted: true }
    }

    if (gate.activeScanId !== null) {
      return {
        available: false,
        busy: true,
        activeScanId: gate.activeScanId,
        activeOperation: gate.activeOperation || 'Verifying clip',
      }
    }

    if (gate.cooldownUntil > now) {
      return {
        available: false,
        busy: true,
        cooling: true,
        waitSec: Math.ceil((gate.cooldownUntil - now) / 1000),
      }
    }

    if (gate.nextFreeAt > now) {
      return {
        available: false,
        busy: true,
        waitSec: Math.ceil((gate.nextFreeAt - now) / 1000),
      }
    }

    if (gate.waiters.length > 0) {
      return {
        available: false,
        busy: true,
        waitSec: 1,
      }
    }

    return { available: true, busy: false }
  }

  /**
   * Acquire lock for Verifier with Anti-Thundering-Herd FIFO queue and 3s pacing.
   */
  public async acquireVerifier(opts: {
    scanId: string
    scanTitle?: string
    apiKey: string
    keyIdx?: number
    modelId: string
    operation: string
    videoSeconds?: number
    rpd?: number
    onWait?: (msg: string, waitSec: number) => void
    isStopping?: () => boolean
  }): Promise<(actualVideoSec?: number, cooldownOverrideMs?: number) => void> {
    const {
      scanId,
      scanTitle = scanId,
      apiKey,
      keyIdx = 1,
      modelId,
      operation,
      rpd = 500,
      onWait,
      isStopping,
    } = opts

    this.checkDayRollover()
    const gate = this.getOrCreateVerifierGate(apiKey, modelId, keyIdx)

    return new Promise((resolve, reject) => {
      const now = Date.now()
      const isFree =
        !gate.isExhausted &&
        !isModelDailyQuotaExhausted(modelId, apiKey, rpd) &&
        gate.activeScanId === null &&
        gate.cooldownUntil <= now &&
        gate.nextFreeAt <= now &&
        gate.waiters.length === 0

      if (isFree) {
        // Grab lock atomically
        gate.activeScanId = scanId
        gate.activeScanTitle = scanTitle
        gate.activeOperation = operation
        gate.activeSince = now

        const release = (actualVideoSec?: number, cooldownOverrideMs?: number) => {
          this.releaseVerifier(gate, cooldownOverrideMs)
        }
        resolve(release)
        return
      }

      const waitSec =
        gate.cooldownUntil > now
          ? Math.ceil((gate.cooldownUntil - now) / 1000)
          : gate.nextFreeAt > now
          ? Math.ceil((gate.nextFreeAt - now) / 1000)
          : 2

      const waitMsg = gate.activeScanId
        ? `[Global Coordinator] Key ${gate.keyIdx} · ${modelId} verifier busy in Scan "${gate.activeScanTitle || gate.activeScanId}". Queued...`
        : gate.cooldownUntil > now
        ? `[Global Coordinator] Key ${gate.keyIdx} · ${modelId} verifier in 60s cooldown (${waitSec}s remaining). Queued...`
        : `[Global Coordinator] Key ${gate.keyIdx} · ${modelId} verifier pacing delay (${waitSec}s remaining). Queued...`

      onWait?.(waitMsg, waitSec)

      gate.waiters.push({
        id: Math.random().toString(36).substring(2, 9),
        scanId,
        scanTitle,
        operation,
        resolve,
        reject,
        isStopping,
      })

      const delayMs = Math.max(
        100,
        gate.cooldownUntil > now
          ? gate.cooldownUntil - now + 50
          : gate.nextFreeAt > now
          ? gate.nextFreeAt - now + 50
          : 500,
      )
      this.scheduleVerifierDispatch(gate, delayMs)
    })
  }

  private scheduleVerifierDispatch(gate: VerifierGateState, delayMs: number) {
    if (gate.dispatchTimer) {
      clearTimeout(gate.dispatchTimer)
      gate.dispatchTimer = null
    }
    gate.dispatchTimer = setTimeout(() => {
      gate.dispatchTimer = null
      this.dispatchNextVerifier(gate)
    }, Math.max(10, delayMs))
  }

  /**
   * ANTI-THUNDERING-HERD DISPATCHER (Verifier):
   * When cooldown or pacing expires, pops and grants the lock to ONLY THE FIRST WAITER.
   * All other parallel scans remain queued and wake up in single file with 3s pacing.
   */
  private dispatchNextVerifier(gate: VerifierGateState) {
    const now = Date.now()
    if (gate.activeScanId !== null) return

    if (gate.cooldownUntil > now) {
      this.scheduleVerifierDispatch(gate, gate.cooldownUntil - now + 50)
      return
    }

    if (gate.nextFreeAt > now) {
      this.scheduleVerifierDispatch(gate, gate.nextFreeAt - now + 50)
      return
    }

    while (gate.waiters.length > 0) {
      const next = gate.waiters.shift()!
      if (next.isStopping && next.isStopping()) {
        next.reject(new Error('Stop requested while queued in verifier coordinator'))
        continue
      }

      // ATOMIC LOCK ACQUISITION:
      gate.activeScanId = next.scanId
      gate.activeScanTitle = next.scanTitle
      gate.activeOperation = next.operation
      gate.activeSince = Date.now()

      const releaseFn = (actualVideoSec?: number, cooldownOverrideMs?: number) => {
        this.releaseVerifier(gate, cooldownOverrideMs)
      }

      next.resolve(releaseFn)
      return // ONLY ONE WAITER RESOLVED!
    }
  }

  private releaseVerifier(gate: VerifierGateState, cooldownOverrideMs?: number) {
    const now = Date.now()
    gate.activeScanId = null
    gate.activeScanTitle = null
    gate.activeOperation = null
    gate.activeSince = null

    if (cooldownOverrideMs && cooldownOverrideMs > 0) {
      gate.cooldownUntil = Math.max(gate.cooldownUntil, now + cooldownOverrideMs)
      this.scheduleVerifierDispatch(gate, cooldownOverrideMs + 50)
    } else {
      // 3,000ms minimum pacing gap between verifier requests on this (key × model).
      // Guarantees maximum ~15-20 RPM, completely collision-free!
      gate.nextFreeAt = Math.max(gate.nextFreeAt, now + 3000)
      this.scheduleVerifierDispatch(gate, 3050)
    }
  }

  // =========================================================================
  // UNIFIED ROUTER & BACKWARDS-COMPATIBLE API
  // =========================================================================

  /**
   * Unified isLaneBusy: Routes to ChunkGate (videoSeconds >= 50) or VerifierGate (videoSeconds < 50)
   */
  public isLaneBusy(
    apiKey: string,
    modelId: string,
    _slot: number = 0,
    rpdCap: number = 500,
    videoSeconds: number = 0,
  ): {
    busy: boolean
    exhausted?: boolean
    activeScanId?: string
    activeScanTitle?: string
    activeOperation?: string
    waitSec?: number
    cooling?: boolean
  } {
    if (videoSeconds >= 50) {
      const res = this.canAcquireChunk(apiKey, modelId, rpdCap)
      return {
        busy: res.busy,
        exhausted: res.exhausted,
        cooling: res.cooling,
        waitSec: res.waitSec,
        activeScanId: res.activeScanId,
        activeOperation: res.activeOperation,
      }
    } else {
      const res = this.canAcquireVerifier(apiKey, modelId, rpdCap)
      return {
        busy: res.busy,
        exhausted: res.exhausted,
        cooling: res.cooling,
        waitSec: res.waitSec,
        activeScanId: res.activeScanId,
        activeOperation: res.activeOperation,
      }
    }
  }

  /**
   * Unified tryAcquireLane: Routes to tryAcquireChunk or tryAcquireVerifier
   */
  public tryAcquireLane(opts: {
    scanId: string
    scanTitle?: string
    apiKey: string
    keyIdx?: number
    modelId: string
    slot?: number
    operation: string
    videoSeconds?: number
    rpd?: number
  }): { release: (actualVideoSec?: number, cooldownOverrideMs?: number) => void } | null {
    const videoSeconds = opts.videoSeconds ?? 60
    if (videoSeconds >= 50) {
      return this.tryAcquireChunk({
        scanId: opts.scanId,
        scanTitle: opts.scanTitle,
        apiKey: opts.apiKey,
        keyIdx: opts.keyIdx,
        modelId: opts.modelId,
        operation: opts.operation,
        rpd: opts.rpd,
      })
    } else {
      const check = this.canAcquireVerifier(opts.apiKey, opts.modelId, opts.rpd ?? 500, opts.keyIdx ?? 1)
      if (!check.available) return null
      const gate = this.getOrCreateVerifierGate(opts.apiKey, opts.modelId, opts.keyIdx ?? 1)
      gate.activeScanId = opts.scanId
      gate.activeScanTitle = opts.scanTitle ?? opts.scanId
      gate.activeOperation = opts.operation
      gate.activeSince = Date.now()
      return {
        release: (actualVideoSec?: number, cooldownOverrideMs?: number) => {
          this.releaseVerifier(gate, cooldownOverrideMs)
        },
      }
    }
  }

  /**
   * Unified acquireLane: Routes to acquireChunk or acquireVerifier
   */
  public async acquireLane(opts: {
    scanId: string
    scanTitle?: string
    apiKey: string
    keyIdx?: number
    modelId: string
    slot?: number
    operation: string
    videoSeconds?: number
    rpd?: number
    onWait?: (msg: string, waitSec: number) => void
    isStopping?: () => boolean
  }): Promise<(actualVideoSec?: number, cooldownOverrideMs?: number) => void> {
    const videoSeconds = opts.videoSeconds ?? 60
    if (videoSeconds >= 50) {
      return this.acquireChunk({
        scanId: opts.scanId,
        scanTitle: opts.scanTitle,
        apiKey: opts.apiKey,
        keyIdx: opts.keyIdx,
        modelId: opts.modelId,
        operation: opts.operation,
        videoSeconds,
        rpd: opts.rpd,
        onWait: opts.onWait,
        isStopping: opts.isStopping,
      })
    } else {
      return this.acquireVerifier({
        scanId: opts.scanId,
        scanTitle: opts.scanTitle,
        apiKey: opts.apiKey,
        keyIdx: opts.keyIdx,
        modelId: opts.modelId,
        operation: opts.operation,
        videoSeconds,
        rpd: opts.rpd,
        onWait: opts.onWait,
        isStopping: opts.isStopping,
      })
    }
  }

  /**
   * Dynamically search across multiple candidate lanes (different API keys and/or models).
   */
  public async acquireFirstAvailableLane(opts: {
    scanId: string
    scanTitle?: string
    candidates: CandidateLane[]
    operation: string
    videoSeconds?: number
    onWait?: (msg: string, waitSec: number, candidateSummary: string) => void
    isStopping?: () => boolean
  }): Promise<{
    selected: CandidateLane
    release: (actualVideoSec?: number) => void
  }> {
    const {
      scanId,
      scanTitle = scanId,
      candidates,
      operation,
      videoSeconds = 60,
      onWait,
      isStopping,
    } = opts

    if (!candidates || candidates.length === 0) {
      throw new Error('No candidate lanes provided for execution')
    }

    let lastLoggedWaitMsg = ''

    while (true) {
      if (isStopping && isStopping()) {
        throw new Error('Stop requested — lane acquisition cancelled')
      }

      this.checkDayRollover()

      const availableCandidates = candidates.filter((c) => {
        return !this.isModelExhausted(c.apiKey, c.modelId, c.rpd || 500)
      })

      if (availableCandidates.length === 0) {
        throw new Error('All candidate keys/models have reached their daily quota or are exhausted')
      }

      const sortedCandidates = [...availableCandidates].sort((a, b) => {
        if (a.keyIdx !== b.keyIdx) return a.keyIdx - b.keyIdx
        const aUsage = getModelUsage(a.modelId, a.apiKey)
        const bUsage = getModelUsage(b.modelId, b.apiKey)
        return aUsage - bUsage
      })

      for (const cand of sortedCandidates) {
        if (videoSeconds >= 50) {
          const check = this.canAcquireChunk(cand.apiKey, cand.modelId, cand.rpd || 20, cand.keyIdx)
          if (check.available) {
            const gate = this.getOrCreateChunkGate(cand.apiKey, cand.modelId, cand.keyIdx)
            gate.activeScanId = scanId
            gate.activeScanTitle = scanTitle
            gate.activeOperation = operation
            gate.activeSince = Date.now()
            return {
              selected: cand,
              release: (actualVideoSec?: number) => {
                this.releaseChunk(gate, actualVideoSec ?? videoSeconds)
              },
            }
          }
        } else {
          const check = this.canAcquireVerifier(cand.apiKey, cand.modelId, cand.rpd || 500, cand.keyIdx)
          if (check.available) {
            const gate = this.getOrCreateVerifierGate(cand.apiKey, cand.modelId, cand.keyIdx)
            gate.activeScanId = scanId
            gate.activeScanTitle = scanTitle
            gate.activeOperation = operation
            gate.activeSince = Date.now()
            return {
              selected: cand,
              release: () => {
                this.releaseVerifier(gate)
              },
            }
          }
        }
      }

      // If all busy, wait 1 second and re-check
      const candidateSummary = availableCandidates
        .map((c) => `Key ${c.keyIdx} (${c.modelId})`)
        .slice(0, 4)
        .join(', ')

      const waitMsg = `[Global Coordinator] All candidate lanes busy (${candidateSummary}). Re-checking in 1s...`
      if (waitMsg !== lastLoggedWaitMsg) {
        lastLoggedWaitMsg = waitMsg
        onWait?.(waitMsg, 1, candidateSummary)
      }

      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  public recordSuccess(apiKey: string, modelId: string, _slot: number = 0) {
    const kmKey = this.getModelKey(apiKey, modelId)
    this.consecutiveErrors.set(kmKey, 0)
  }

  public reportRateLimit(
    apiKey: string,
    modelId: string,
    cooldownMs: number = RATE_COOLDOWN_MS,
    _slot: number = 0,
  ) {
    const now = Date.now()
    const kmKey = this.getModelKey(apiKey, modelId)
    const cg = this.chunkGates.get(kmKey)
    const vg = this.verifierGates.get(kmKey)

    if (cg) {
      cg.cooldownUntil = Math.max(cg.cooldownUntil, now + cooldownMs)
      this.scheduleChunkDispatch(cg, cooldownMs + 50)
    }
    if (vg) {
      vg.cooldownUntil = Math.max(vg.cooldownUntil, now + cooldownMs)
      this.scheduleVerifierDispatch(vg, cooldownMs + 50)
    }
  }

  public handleQuotaOrRateError(
    apiKey: string,
    modelId: string,
    slot: number = 0,
    rpdCap: number = 20,
    isExplicitDailyMsg: boolean = false,
    keyIdx: number = 1,
    retryWaitSec?: number,
  ): {
    action: 'cooldown' | 'exhausted'
    waitSec: number
    reason: string
  } {
    this.checkDayRollover()
    const used = getModelUsage(modelId, apiKey)
    const kmKey = this.getModelKey(apiKey, modelId)

    // Quota in Settings is the absolute final source of truth:
    // If used < rpdCap, quota is NOT exhausted! Treat any 429/Resource Exhausted as a temporary TPM rate limit.
    if (used >= rpdCap) {
      this.reportExhausted(apiKey, modelId, slot, rpdCap)
      return {
        action: 'exhausted',
        waitSec: 0,
        reason: `Daily quota limit reached (${used}/${rpdCap} RPD) on ${modelId} (Key ${keyIdx})`,
      }
    }

    const errors = (this.consecutiveErrors.get(kmKey) || 0) + 1
    this.consecutiveErrors.set(kmKey, errors)

    const effectiveCooldownMs = retryWaitSec && retryWaitSec > 0
      ? (retryWaitSec * 1000) + 2000
      : CHUNK_COOLDOWN_MS

    // Cooldown both chunk and verifier gates on this model:
    this.reportRateLimit(apiKey, modelId, effectiveCooldownMs, slot)

    const waitSec = Math.ceil(effectiveCooldownMs / 1000)
    return {
      action: 'cooldown',
      waitSec,
      reason: `TPM rate limit hit on ${modelId} (Key ${keyIdx}, used ${used}/${rpdCap} RPD — quota remaining: ${rpdCap - used}) — waiting ${waitSec}s before retry`,
    }
  }

  public reportExhausted(apiKey: string, modelId: string, _slot: number = 0, rpdCap: number = 20) {
    const kmKey = this.getModelKey(apiKey, modelId)
    const cg = this.chunkGates.get(kmKey)
    const vg = this.verifierGates.get(kmKey)

    if (cg) {
      cg.isExhausted = true
      while (cg.waiters.length > 0) {
        const w = cg.waiters.shift()
        w?.reject(new Error(`[Global Coordinator] Model ${modelId} reached daily limit (${rpdCap} RPD)`))
      }
    }

    if (vg) {
      vg.isExhausted = true
      while (vg.waiters.length > 0) {
        const w = vg.waiters.shift()
        w?.reject(new Error(`[Global Coordinator] Model ${modelId} reached daily limit (${rpdCap} RPD)`))
      }
    }

    try {
      setModelExhausted(modelId, apiKey, rpdCap)
    } catch {}
  }

  public resetAllLanes(): void {
    for (const cg of this.chunkGates.values()) {
      cg.isExhausted = false
      cg.cooldownUntil = 0
      cg.activeScanId = null
      if (cg.dispatchTimer) clearTimeout(cg.dispatchTimer)
      cg.dispatchTimer = null
    }
    for (const vg of this.verifierGates.values()) {
      vg.isExhausted = false
      vg.cooldownUntil = 0
      vg.nextFreeAt = 0
      vg.activeScanId = null
      if (vg.dispatchTimer) clearTimeout(vg.dispatchTimer)
      vg.dispatchTimer = null
    }
    this.consecutiveErrors.clear()
    console.log('[Global Coordinator] All chunk and verifier gates reset.')
  }

  public getSnapshot(): Array<{
    laneKey: string
    keyIdx: number
    modelId: string
    activeScanId: string | null
    activeScanTitle: string | null
    activeOperation: string | null
    waitingCount: number
    cooling: boolean
    pacingWaitSec: number
  }> {
    const now = Date.now()
    const out: Array<{
      laneKey: string
      keyIdx: number
      modelId: string
      activeScanId: string | null
      activeScanTitle: string | null
      activeOperation: string | null
      waitingCount: number
      cooling: boolean
      pacingWaitSec: number
    }> = []

    for (const cg of this.chunkGates.values()) {
      out.push({
        laneKey: `${cg.kmKey}:chunk`,
        keyIdx: cg.keyIdx,
        modelId: cg.modelId,
        activeScanId: cg.activeScanId,
        activeScanTitle: cg.activeScanTitle,
        activeOperation: cg.activeOperation,
        waitingCount: cg.waiters.length,
        cooling: cg.cooldownUntil > now,
        pacingWaitSec: Math.max(0, Math.ceil((cg.cooldownUntil - now) / 1000)),
      })
    }

    for (const vg of this.verifierGates.values()) {
      out.push({
        laneKey: `${vg.kmKey}:verifier`,
        keyIdx: vg.keyIdx,
        modelId: vg.modelId,
        activeScanId: vg.activeScanId,
        activeScanTitle: vg.activeScanTitle,
        activeOperation: vg.activeOperation,
        waitingCount: vg.waiters.length,
        cooling: vg.cooldownUntil > now,
        pacingWaitSec: Math.max(0, Math.ceil((Math.max(vg.nextFreeAt, vg.cooldownUntil) - now) / 1000)),
      })
    }

    return out
  }
}

const globalCoordinatorKey = Symbol.for('__global_gemini_coordinator__')
const globalObj = globalThis as unknown as { [globalCoordinatorKey]?: GlobalGeminiCoordinator }

if (!globalObj[globalCoordinatorKey]) {
  globalObj[globalCoordinatorKey] = new GlobalGeminiCoordinator()
}

export const globalGeminiCoordinator = globalObj[globalCoordinatorKey]!
