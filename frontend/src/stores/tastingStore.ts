import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, readLastBackupAt, stampBackupTime } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  averageScore,
  createEmptyTastingFilter,
  scoreToConclusion,
  type BatchScore,
  type Tasting,
  type TastingConclusion,
  type TastingFilterState
} from '@/types/tasting'
import type { Batch } from '@/types/batch'
import type { Environment } from '@/types/environment'
import type { Turning } from '@/types/turning'
import { useMilkStore } from '@/stores/milkStore'
import { round } from '@/utils/temperature'
import {
  buildBasis,
  checkGate,
  collectEvidence,
  decideExistingBatches,
  evaluateBasis,
  type BatchDecision,
  type BatchEvidence,
  type BasisStatus
} from '@/utils/judgment'

export interface NewTastingInput {
  batchId: string
  outAt: string
  appearance: string
  flavor: string
  texture: string
  appearanceScore: number
  flavorScore: number
  textureScore: number
  taster: string
}

/** 品评行：品评 + 批次 + 奶源名回显 */
export interface TastingRow {
  tasting: Tasting
  batch: Batch | null
  batchLabel: string
  milkLabel: string
  /** 该品评依据当前是否有效（含失效原因），批量派生 */
  basisStatus: BasisStatus
}

/** 判定链核检未通过（缺项挡下）时抛出，页面据此提示并阻止出库品评 */
export class GateBlockedError extends Error {
  gate: BatchDecision['gate']
  constructor(gate: BatchDecision['gate']) {
    const detail = gate.items
      .filter((item) => !item.ok)
      .map((item) => item.detail)
      .join('；')
    super(`判定链核检未通过，品评已挡下：${detail}`)
    this.name = 'GateBlockedError'
    this.gate = gate
  }
}

/**
 * 品评 store：出库品评判定链。
 * - 品评前先核检环境异常处置与转架签署进度，缺项挡下（GateBlockedError）；
 * - 结论按三维均分换算，保存 / 复核时落「依据快照」；
 * - 依据（环境、转架、同批次品评集合）事后被改动而未复核时，结论失效、需重算复核；
 * - 提交 / 复核全部走 Dexie 事务并在事务内重读最新依据，两个窗口同时提交时
 *   后落的一次按最新依据重算，不沿用旧结论。
 */
export const useTastingStore = defineStore('tasting', () => {
  const tastingsTable = useIdbTable<Tasting>((database) => database.tastings)
  const environmentsTable = useIdbTable<Environment>((database) => database.environments, {
    sortByUpdatedAt: false
  })
  const turningsTable = useIdbTable<Turning>((database) => database.turnings, {
    sortByUpdatedAt: false
  })
  const milkStore = useMilkStore()

  const filter = ref<TastingFilterState>(createEmptyTastingFilter())
  const lastBackupAt = ref<string | null>(readLastBackupAt())
  const busy = ref(false)

  const tastings = computed<Tasting[]>(() => tastingsTable.rows.value)
  const environments = computed<Environment[]>(() => environmentsTable.rows.value)
  const turnings = computed<Turning[]>(() => turningsTable.rows.value)
  const loading = computed(() => tastingsTable.loading.value)
  const ready = computed(() => tastingsTable.ready.value)
  const error = computed(() => tastingsTable.error.value)
  const batches = computed<Batch[]>(() => milkStore.batches)

  /** 同批次均分与各维度均分，用于回写批次结论 */
  const batchScores = computed<BatchScore[]>(() => {
    const grouped = new Map<string, Tasting[]>()
    tastings.value.forEach((tasting) => {
      const bucket = grouped.get(tasting.batchId) ?? []
      bucket.push(tasting)
      grouped.set(tasting.batchId, bucket)
    })
    const result: BatchScore[] = []
    grouped.forEach((list, batchId) => {
      const avg = (pick: (item: Tasting) => number): number =>
        round(list.reduce((sum, item) => sum + pick(item), 0) / list.length, 1)
      const avgScore = avg((item) => item.score)
      result.push({
        batchId,
        count: list.length,
        avgScore,
        conclusion: scoreToConclusion(avgScore),
        avgAppearance: avg((item) => item.appearanceScore),
        avgFlavor: avg((item) => item.flavorScore),
        avgTexture: avg((item) => item.textureScore),
        lastOutAt:
          list
            .map((item) => item.outAt)
            .sort((a, b) => b.localeCompare(a))[0] ?? ''
      })
    })
    return result.sort((a, b) => b.avgScore - a.avgScore)
  })

  const batchScoreMap = computed<Record<string, BatchScore>>(() => {
    const map: Record<string, BatchScore> = {}
    batchScores.value.forEach((score) => {
      map[score.batchId] = score
    })
    return map
  })

  /** 每个批次的判定链状态（核检 + 依据有效性），随环境 / 转架 / 品评实时派生 */
  const decisionMap = computed<Map<string, BatchDecision>>(() =>
    decideExistingBatches(
      batches.value,
      environments.value,
      turnings.value,
      tastings.value
    )
  )

  function decisionOf(batchId: string): BatchDecision | null {
    return decisionMap.value.get(batchId) ?? null
  }

  function evidenceOf(batchId: string): BatchEvidence {
    return collectEvidence(batchId, environments.value, turnings.value)
  }

  /** 直接核检某批次的判定链（对话框打开时展示） */
  function gateOf(batchId: string) {
    return checkGate(evidenceOf(batchId))
  }

  /** 当前已失效（依据被改动、未复核）的品评记录数 */
  const invalidTastingCount = computed(() => {
    let count = 0
    tastings.value.forEach((tasting) => {
      if (!decisionMap.value.get(tasting.batchId)?.anchor) return
      const status = basisStatusOf(tasting.id)
      if (status && !status.valid) count += 1
    })
    return count
  })

  /** 已落了结论但判定链不成立（核检未过或依据失效）的批次数 */
  const invalidBatchCount = computed(
    () =>
      Array.from(decisionMap.value.values()).filter(
        (decision) => decision.anchor !== null && !decision.valid
      ).length
  )

  function tastingsOfBatch(batchId: string): Tasting[] {
    return tastings.value.filter((tasting) => tasting.batchId === batchId)
  }

  /** 单条品评依据核对结果（无品评 / 批次已删除时返回 null） */
  function basisStatusOf(tastingId: string): BasisStatus | null {
    const tasting = tastings.value.find((item) => item.id === tastingId)
    if (!tasting) return null
    const evidence = collectEvidence(tasting.batchId, environments.value, turnings.value)
    return evaluateBasis(tasting, evidence, tastingsOfBatch(tasting.batchId))
  }

  const rows = computed<TastingRow[]>(() =>
    tastings.value.map((tasting) => {
      const batch = batches.value.find((item) => item.id === tasting.batchId) ?? null
      return {
        tasting,
        batch,
        batchLabel: batch ? `${batch.cheeseType} · ${batch.curdedAt}` : '批次已删除',
        milkLabel: batch ? milkStore.milkNameOf(batch.milkId) : '—',
        basisStatus: basisStatusOf(tasting.id) ?? { valid: false, missing: true, invalidReason: '批次已删除' }
      }
    })
  )

  /** 关键字 + 批次多选 + 结论多选过滤 */
  const filteredRows = computed<TastingRow[]>(() =>
    rows.value.filter((row) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.tasting.appearance}${row.tasting.flavor}${row.tasting.texture}${row.tasting.taster}${row.tasting.conclusion}${row.batchLabel}${row.milkLabel}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.batchIds.length > 0 && !filter.value.batchIds.includes(row.tasting.batchId)) {
        return false
      }
      if (
        filter.value.conclusions.length > 0 &&
        !filter.value.conclusions.includes(row.tasting.conclusion)
      ) {
        return false
      }
      return true
    })
  )

  const avgScore = computed(() =>
    tastings.value.length === 0
      ? 0
      : round(
          tastings.value.reduce((sum, tasting) => sum + tasting.score, 0) / tastings.value.length,
          1
        )
  )

  const conclusionCounts = computed<Record<TastingConclusion, number>>(() => {
    const counts: Record<TastingConclusion, number> = { 优: 0, 合格: 0, 待改进: 0 }
    tastings.value.forEach((tasting) => {
      counts[tasting.conclusion] += 1
    })
    return counts
  })

  const excellentPercent = computed(() =>
    tastings.value.length === 0
      ? 0
      : Math.round((conclusionCounts.value['优'] / tastings.value.length) * 100)
  )

  /** 待品评的批次：已出库但尚无品评记录 */
  const pendingBatches = computed<Batch[]>(() =>
    batches.value.filter(
      (batch) =>
        batch.state === '已出库' && !tastings.value.some((tasting) => tasting.batchId === batch.id)
    )
  )

  function tastingsOf(batchId: string): Tasting[] {
    return tastings.value
      .filter((tasting) => tasting.batchId === batchId)
      .sort((a, b) => b.outAt.localeCompare(a.outAt))
  }

  function scoreOf(batchId: string): BatchScore | null {
    return batchScoreMap.value[batchId] ?? null
  }

  function setLastBackupAt(iso: string | null): void {
    lastBackupAt.value = iso
  }

  function markBackupNow(): void {
    const iso = new Date().toISOString()
    stampBackupTime(iso)
    lastBackupAt.value = iso
  }

  function patchFilter(patch: Partial<TastingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyTastingFilter()
  }

  /** 按当前同批次品评均分换算批次结论（无品评清空） */
  function conclusionFromList(list: Tasting[]): string {
    if (list.length === 0) return ''
    const avg = list.reduce((sum, item) => sum + item.score, 0) / list.length
    return scoreToConclusion(round(avg, 1))
  }

  /**
   * 新建品评：事务内重读最新环境 / 转架 / 品评，先过判定链核检（缺项挡下），
   * 再按三维均分算结论、落依据快照并重算回写批次结论。
   */
  async function createTasting(payload: NewTastingInput): Promise<Tasting> {
    const now = Date.now()
    const score = averageScore(payload.appearanceScore, payload.flavorScore, payload.textureScore)
    const createdRef: { value: Tasting | null } = { value: null }
    await db.transaction(
      'rw',
      [db.tastings, db.batches, db.environments, db.turnings],
      async () => {
        const [envs, turns, allTastings] = await Promise.all([
          db.environments.toArray(),
          db.turnings.toArray(),
          db.tastings.toArray()
        ])
        const evidence = collectEvidence(payload.batchId, envs, turns)
        const gate = checkGate(evidence)
        if (!gate.ok) throw new GateBlockedError(gate)

        const record: Tasting = {
          ...payload,
          score,
          conclusion: scoreToConclusion(score),
          basis: null,
          id: `tast_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          createdAt: now,
          updatedAt: now
        }
        const ofBatch = [...allTastings.filter((item) => item.batchId === payload.batchId), record]
        record.basis = buildBasis(evidence, ofBatch, now)
        await db.tastings.put(record)
        await db.batches.update(payload.batchId, {
          conclusion: conclusionFromList(ofBatch),
          updatedAt: now
        })
        createdRef.value = record
      }
    )
    if (!createdRef.value) throw new Error('品评保存失败')
    return createdRef.value
  }

  /**
   * 编辑品评：同样先过判定链核检；改分时重算总分 / 结论，
   * 以最新依据重新落快照，并重算回写批次均分结论（后落的一次按最新依据重算）。
   */
  async function updateTasting(id: string, patch: Partial<Tasting>): Promise<void> {
    const now = Date.now()
    await db.transaction(
      'rw',
      [db.tastings, db.batches, db.environments, db.turnings],
      async () => {
        const current = await db.tastings.get(id)
        if (!current) return
        const [envs, turns, allTastings] = await Promise.all([
          db.environments.toArray(),
          db.turnings.toArray(),
          db.tastings.toArray()
        ])
        const evidence = collectEvidence(current.batchId, envs, turns)
        const gate = checkGate(evidence)
        if (!gate.ok) throw new GateBlockedError(gate)

        const merged: Tasting = { ...current, ...patch, batchId: current.batchId, id, updatedAt: now }
        if (
          patch.appearanceScore !== undefined ||
          patch.flavorScore !== undefined ||
          patch.textureScore !== undefined
        ) {
          merged.score = averageScore(
            merged.appearanceScore,
            merged.flavorScore,
            merged.textureScore
          )
          merged.conclusion = scoreToConclusion(merged.score)
        }
        const ofBatch = allTastings
          .filter((item) => item.id !== id && item.batchId === current.batchId)
          .concat(merged)
        merged.basis = buildBasis(evidence, ofBatch, now)
        await db.tastings.put(merged)
        await db.batches.update(current.batchId, {
          conclusion: conclusionFromList(ofBatch),
          updatedAt: now
        })
      }
    )
  }

  /**
   * 删除品评：删除后按剩余记录重算批次均分结论；
   * 锚定到剩余品评的依据因「品评集合变化」自动失效，需重新复核。
   */
  async function removeTasting(id: string): Promise<void> {
    const now = Date.now()
    await db.transaction(
      'rw',
      [db.tastings, db.batches],
      async () => {
        const tasting = await db.tastings.get(id)
        if (!tasting) return
        await db.tastings.delete(id)
        const rest = (await db.tastings.toArray()).filter((item) => item.batchId === tasting.batchId)
        await db.batches.update(tasting.batchId, {
          conclusion: conclusionFromList(rest),
          updatedAt: now
        })
      }
    )
  }

  /**
   * 复核单条品评：按最新依据重新核对判定链并落新快照，重算批次结论。
   * 核检缺项时挡下（GateBlockedError）。
   */
  async function reviewTasting(id: string): Promise<Tasting> {
    const now = Date.now()
    const reviewedRef: { value: Tasting | null } = { value: null }
    await db.transaction(
      'rw',
      [db.tastings, db.batches, db.environments, db.turnings],
      async () => {
        const current = await db.tastings.get(id)
        if (!current) throw new Error('品评记录不存在')
        const [envs, turns, allTastings] = await Promise.all([
          db.environments.toArray(),
          db.turnings.toArray(),
          db.tastings.toArray()
        ])
        const evidence = collectEvidence(current.batchId, envs, turns)
        const gate = checkGate(evidence)
        if (!gate.ok) throw new GateBlockedError(gate)

        const ofBatch = allTastings.filter((item) => item.batchId === current.batchId)
        const record: Tasting = {
          ...current,
          basis: buildBasis(evidence, ofBatch, now),
          updatedAt: now
        }
        await db.tastings.put(record)
        await db.batches.update(current.batchId, {
          conclusion: conclusionFromList(ofBatch),
          updatedAt: now
        })
        reviewedRef.value = record
      }
    )
    if (!reviewedRef.value) throw new Error('品评复核失败')
    return reviewedRef.value
  }

  /**
   * 复核整个批次：以最新依据重锚定最近一次品评的依据快照并重算结论。
   * 核检未过时挡下，提示先补齐缺项。
   */
  async function reviewBatch(batchId: string): Promise<{ conclusion: string; count: number }> {
    const now = Date.now()
    await db.transaction(
      'rw',
      [db.tastings, db.batches, db.environments, db.turnings],
      async () => {
        const [envs, turns, allTastings] = await Promise.all([
          db.environments.toArray(),
          db.turnings.toArray(),
          db.tastings.toArray()
        ])
        const evidence = collectEvidence(batchId, envs, turns)
        const gate = checkGate(evidence)
        if (!gate.ok) throw new GateBlockedError(gate)

        const ofBatch = allTastings
          .filter((item) => item.batchId === batchId)
          .sort((a, b) => {
            const diff = b.updatedAt - a.updatedAt
            return diff !== 0 ? diff : b.createdAt - a.createdAt
          })
        if (ofBatch.length === 0) {
          await db.batches.update(batchId, { conclusion: '', updatedAt: now })
          return
        }
        const anchor = ofBatch[0]
        await db.tastings.put({ ...anchor, basis: buildBasis(evidence, ofBatch, now), updatedAt: now })
        await db.batches.update(batchId, {
          conclusion: conclusionFromList(ofBatch),
          updatedAt: now
        })
      }
    )
    const score = scoreOf(batchId)
    return { conclusion: score?.conclusion ?? '', count: score?.count ?? 0 }
  }

  /** 复核所有有品评记录且判定链成立的批次；返回复核数与被挡下的批次信息 */
  async function reviewAllBatches(): Promise<{ reviewed: number; blocked: Array<{ batchId: string; reason: string }> }> {
    const batchIds = Array.from(new Set(tastings.value.map((tasting) => tasting.batchId)))
    const blocked: Array<{ batchId: string; reason: string }> = []
    let reviewed = 0
    for (const batchId of batchIds) {
      try {
        await reviewBatch(batchId)
        reviewed += 1
      } catch (err) {
        if (err instanceof GateBlockedError) {
          blocked.push({ batchId, reason: err.message })
        } else {
          throw err
        }
      }
    }
    return { reviewed, blocked }
  }

  return {
    tastings,
    environments,
    turnings,
    rows,
    filteredRows,
    loading,
    ready,
    error,
    filter,
    busy,
    lastBackupAt,
    batchScores,
    batchScoreMap,
    decisionMap,
    invalidTastingCount,
    invalidBatchCount,
    avgScore,
    conclusionCounts,
    excellentPercent,
    pendingBatches,
    evidenceOf,
    gateOf,
    decisionOf,
    basisStatusOf,
    tastingsOf,
    scoreOf,
    setLastBackupAt,
    markBackupNow,
    patchFilter,
    resetFilter,
    createTasting,
    updateTasting,
    removeTasting,
    reviewTasting,
    reviewBatch,
    reviewAllBatches
  }
})

export type TastingStore = ReturnType<typeof useTastingStore>
