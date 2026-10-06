import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { liveQuery } from 'dexie'
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
  buildArchiveSummary,
  buildBasis,
  computeBasisSignature,
  evaluateBatch,
  evaluateGate,
  invalidReasonOf,
  judgmentStatusOf,
  parseStoredBasis,
  type ArchiveJudgmentSummary,
  type BatchGate,
  type JudgmentBasis
} from '@/utils/judgement'

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

/** 品评提交 / 复核结果：闸门挡下时 ok=false 且 gate 给出缺项明细 */
export interface TastingSubmitResult {
  ok: boolean
  gate: BatchGate
  /** 挡下或失效的原因文案 */
  reason: string
  tasting?: Tasting
  conclusion?: TastingConclusion | ''
  basis?: JudgmentBasis | null
}

/** 品评行：品评 + 批次 + 奶源名回显 */
export interface TastingRow {
  tasting: Tasting
  batch: Batch | null
  batchLabel: string
  milkLabel: string
}

/** 浏览器锁不可用时退化为进程内串行（Promise 链） */
let submissionChain: Promise<unknown> = Promise.resolve()

/**
 * 品评提交串行化：两个窗口（标签页）同时提交同批次品评时，
 * 后落的一次必须等先落的一次完成闸门核查与均分回写后，再按最新依据重算。
 */
async function withSubmissionLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator & {
    locks?: { request: (name: string, callback: () => Promise<T>) => Promise<T> }
  }).locks
  if (locks?.request) {
    return locks.request('gbcheeseage:tasting-judgement', task)
  }
  const run = submissionChain.then(task, task)
  submissionChain = run.catch(() => undefined)
  return run
}

/**
 * 品评 store：维护品评记录、批次均分派生值与「判定链」。
 * 品评前闸门（环境异常处置 / 转架签署）→ 均分连同依据落库 → 依据变动自动失效 → 复核重算。
 * 同时提供全量 JSON 导入导出的落地能力（文件下载由 utils/export.ts 负责）。
 */
export const useTastingStore = defineStore('tasting', () => {
  const tastingsTable = useIdbTable<Tasting>((database) => database.tastings)
  const milkStore = useMilkStore()

  const filter = ref<TastingFilterState>(createEmptyTastingFilter())
  const lastBackupAt = ref<string | null>(readLastBackupAt())
  const busy = ref(false)

  // 判定链依据的另外两环：环境记录与转架作业。品评 store 是判定链的唯一写回方，
  // 这里直接订阅，保证依据一改动就能发现签名失配。
  const environments = ref<Environment[]>([])
  const turnings = ref<Turning[]>([])
  const envSubscription = shallowRef<{ unsubscribe: () => void } | null>(
    liveQuery(() => db.environments.toArray()).subscribe({
      next: (list) => {
        environments.value = list
      }
    })
  )
  const turningSubscription = shallowRef<{ unsubscribe: () => void } | null>(
    liveQuery(() => db.turnings.toArray()).subscribe({
      next: (list) => {
        turnings.value = list
      }
    })
  )
  onScopeDispose(() => {
    envSubscription.value?.unsubscribe()
    turningSubscription.value?.unsubscribe()
  })

  const tastings = computed<Tasting[]>(() => tastingsTable.rows.value)
  const loading = computed(() => tastingsTable.loading.value)
  const ready = computed(() => tastingsTable.ready.value)
  const error = computed(() => tastingsTable.error.value)
  const batches = computed<Batch[]>(() => milkStore.batches)

  function environmentsOf(batchId: string): Environment[] {
    return environments.value.filter((record) => record.batchId === batchId)
  }

  function turningsOfBatch(batchId: string): Turning[] {
    return turnings.value.filter((turning) => turning.batchId === batchId)
  }

  function evidenceOf(batchId: string) {
    const batch = batches.value.find((item) => item.id === batchId)
    return {
      batch,
      environments: environmentsOf(batchId),
      turnings: turningsOfBatch(batchId),
      tastings: tastings.value
        .filter((tasting) => tasting.batchId === batchId)
        .sort((a, b) => a.outAt.localeCompare(b.outAt))
    }
  }

  /** 品评前闸门核查：缺项（未处置异常 / 待执行转架）时 blocked=true */
  function gateOf(batchId: string): BatchGate {
    return evaluateGate(evidenceOf(batchId))
  }

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
      const batch = batches.value.find((item) => item.id === batchId)
      const gate = evaluateGate({
        batch,
        environments: environmentsOf(batchId),
        turnings: turningsOfBatch(batchId),
        tastings: list
      })
      const status = batch ? judgmentStatusOf(batch) : 'none'
      const invalidReason =
        status === 'invalid'
          ? invalidReasonOf(batch as Batch)
          : gate.blocked
            ? formatGateReason(gate)
            : ''
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
            .sort((a, b) => b.localeCompare(a))[0] ?? '',
        blocked: gate.blocked,
        valid: status === 'valid',
        invalidReason
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

  const rows = computed<TastingRow[]>(() =>
    tastings.value.map((tasting) => {
      const batch = batches.value.find((item) => item.id === tasting.batchId) ?? null
      return {
        tasting,
        batch,
        batchLabel: batch ? `${batch.cheeseType} · ${batch.curdedAt}` : '批次已删除',
        milkLabel: batch ? milkStore.milkNameOf(batch.milkId) : '—'
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

  /** 闸门挡下、暂不能品评的批次（已出库 + 有未处置异常或待执行转架） */
  const blockedBatches = computed<Batch[]>(() =>
    batches.value.filter(
      (batch) => batch.state !== '报废' && gateOf(batch.id).blocked
    )
  )

  /** 已有回写结论但依据已变动、未复核的批次 */
  const invalidBatches = computed<Batch[]>(() =>
    batches.value.filter((batch) => judgmentStatusOf(batch) === 'invalid')
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

  /** 闸门缺项 → 可读的挡下原因 */
  function formatGateReason(gate: BatchGate): string {
    const reasons: string[] = []
    if (gate.unresolvedAnomalies.length > 0) {
      reasons.push(
        `${gate.unresolvedAnomalies.length} 条越界温湿度未补录处置措施（${gate.unresolvedAnomalies
          .map((item) => item.recordedAt.slice(5, 16))
          .join('、')}）`
      )
    }
    if (gate.pendingTurnings.length > 0) {
      reasons.push(
        `${gate.pendingTurnings.length} 条转架作业未签署（${gate.pendingTurnings
          .map((item) => `${item.type} ${item.doneAt.slice(5)}`)
          .join('、')}）`
      )
    }
    return `判定链闸门挡下：${reasons.join('；')}`
  }

  /**
   * 依据变动 → 结论失效。
   * 环境 / 转架变化后比对实时签名：一致且未失效则不动；失配则清空批次回写结论、
   * 置失效标记并写入原因。依据补齐后不会自动复活，必须显式复核（applyJudgment）。
   */
  async function invalidateBatch(batchId: string, reason?: string): Promise<void> {
    const batch = await db.batches.get(batchId)
    if (!batch) return
    if (!batch.conclusion && !batch.judgmentInvalid) return
    const evidence = await readEvidence(batchId)
    const currentSignature = computeBasisSignature(evidence)
    const matched =
      !!batch.judgmentBasisSignature && batch.judgmentBasisSignature === currentSignature
    if (matched && !batch.judgmentInvalid) return
    const finalReason =
      reason ?? '判定依据已发生变化（品评打分 / 越界温湿度 / 转架签署），未经复核的结论已失效'
    await db.batches.update(batchId, {
      conclusion: '',
      judgmentInvalid: true,
      judgmentInvalidReason: finalReason,
      updatedAt: Date.now()
    })
  }

  /** 直接从 IndexedDB 读取一批次的判定依据（锁内 / watcher 内使用，避免拿到响应式旧值） */
  async function readEvidence(batchId: string) {
    const [batch, environmentsList, turningsList, tastingsList] = await Promise.all([
      db.batches.get(batchId),
      db.environments.where('batchId').equals(batchId).toArray(),
      db.turnings.where('batchId').equals(batchId).toArray(),
      db.tastings.where('batchId').equals(batchId).toArray()
    ])
    return {
      batch,
      environments: environmentsList,
      turnings: turningsList,
      tastings: tastingsList.sort((a, b) => a.outAt.localeCompare(b.outAt))
    }
  }

  /** 新建品评：先过闸门，再连同依据落库并回写批次结论 */
  async function createTasting(payload: NewTastingInput): Promise<TastingSubmitResult> {
    return withSubmissionLock(async () => {
      const evidence = await readEvidence(payload.batchId)
      if (!evidence.batch) {
        return { ok: false, gate: evaluateGate(evidence), reason: '批次不存在，无法品评' }
      }
      const gate = evaluateGate(evidence)
      if (gate.blocked) {
        return { ok: false, gate, reason: formatGateReason(gate) }
      }
      const score = averageScore(
        payload.appearanceScore,
        payload.flavorScore,
        payload.textureScore
      )
      const tasting = await tastingsTable.create(
        {
          ...payload,
          score,
          conclusion: scoreToConclusion(score),
          basis: '',
          basisSignature: ''
        },
        'tast'
      )
      // 新品评落库后按「最新依据」（含本次）重算均分与依据快照
      const basis = await applyJudgment(payload.batchId)
      return {
        ok: true,
        gate,
        reason: '',
        tasting,
        conclusion: basis?.conclusion ?? '',
        basis
      }
    })
  }

  async function updateTasting(id: string, patch: Partial<Tasting>): Promise<TastingSubmitResult> {
    return withSubmissionLock(async () => {
      const current = await db.tastings.get(id)
      if (!current) {
        return {
          ok: false,
          gate: evaluateGate({ environments: [], turnings: [], tastings: [] }),
          reason: '品评记录不存在'
        }
      }
      const evidence = await readEvidence(current.batchId)
      const gate = evaluateGate(evidence)
      const merged: Partial<Tasting> = { ...patch }
      if (
        patch.appearanceScore !== undefined ||
        patch.flavorScore !== undefined ||
        patch.textureScore !== undefined
      ) {
        const score = averageScore(
          patch.appearanceScore ?? current.appearanceScore,
          patch.flavorScore ?? current.flavorScore,
          patch.textureScore ?? current.textureScore
        )
        merged.score = score
        merged.conclusion = scoreToConclusion(score)
      }
      await tastingsTable.update(id, merged)
      if (gate.blocked) {
        // 依据缺项时只改记录本身，并让批次结论失效，不能沿用旧结论
        await invalidateBatch(
          current.batchId,
          `${formatGateReason(gate)}；品评改动后的结论待缺项补齐后复核重算`
        )
        return { ok: false, gate, reason: formatGateReason(gate) }
      }
      const basis = await applyJudgment(current.batchId)
      // 品评被挪到别的批次时，原批次与新批次都要按最新依据重算
      const targetBatchId = patch.batchId ?? current.batchId
      if (targetBatchId !== current.batchId) {
        await applyJudgment(targetBatchId)
        const remaining = await db.tastings.where('batchId').equals(current.batchId).count()
        if (remaining === 0) {
          await db.batches.update(current.batchId, {
            conclusion: '',
            judgmentBasis: '',
            judgmentBasisSignature: '',
            judgmentInvalid: false,
            judgmentInvalidReason: '',
            judgmentAt: '',
            updatedAt: Date.now()
          })
        } else {
          await applyJudgment(current.batchId)
        }
      }
      return { ok: true, gate, reason: '', conclusion: basis?.conclusion ?? '', basis }
    })
  }

  async function removeTasting(id: string): Promise<void> {
    const tasting = await db.tastings.get(id)
    if (!tasting) {
      await tastingsTable.remove(id)
      return
    }
    await withSubmissionLock(async () => {
      await db.tastings.delete(id)
      const remaining = await db.tastings.where('batchId').equals(tasting.batchId).count()
      if (remaining === 0) {
        await db.batches.update(tasting.batchId, {
          conclusion: '',
          judgmentBasis: '',
          judgmentBasisSignature: '',
          judgmentInvalid: false,
          judgmentInvalidReason: '',
          judgmentAt: '',
          updatedAt: Date.now()
        })
      } else {
        // 删除品评同样改变依据：后落的操作按最新依据重算，不沿用旧结论
        await applyJudgment(tasting.batchId)
      }
    })
  }

  /**
   * 复核重算（判定链落库的唯一出口）：
   * 读取最新品评 / 环境 / 转架 → 闸门 → 均分结论 + 依据快照 → 回写批次并给每条品评盖依据章。
   * 返回 null 表示闸门未放行或已无品评，此时不会形成结论。
   */
  async function applyJudgment(batchId: string): Promise<JudgmentBasis | null> {
    const evidence = await readEvidence(batchId)
    if (!evidence.batch) return null
    const basis = buildBasis(evidence)
    const now = Date.now()
    if (!basis) {
      const gate = evaluateGate(evidence)
      await db.batches.update(batchId, {
        conclusion: '',
        judgmentInvalid: gate.blocked,
        judgmentInvalidReason: gate.blocked ? formatGateReason(gate) : '',
        updatedAt: now
      })
      return null
    }
    const basisJson = JSON.stringify(basis)
    await db.transaction(
      'rw',
      [db.batches, db.tastings],
      async () => {
        await db.batches.update(batchId, {
          conclusion: basis.conclusion,
          judgmentBasis: basisJson,
          judgmentBasisSignature: basis.signature,
          judgmentInvalid: false,
          judgmentInvalidReason: '',
          judgmentAt: basis.evaluatedAt,
          updatedAt: now
        })
        // 每条品评都带上同一份依据，导出时单条记录也能看到判定依据
        await db.tastings
          .where('batchId')
          .equals(batchId)
          .modify((tasting) => {
            tasting.basis = basisJson
            tasting.basisSignature = basis.signature
          })
      }
    )
    return basis
  }

  /**
   * 均分回写 / 复核批次结论：按最新依据重算。
   * 闸门缺项时挡下并返回空结论，由页面提示先补齐依据。
   */
  async function syncBatchConclusion(batchId: string): Promise<TastingSubmitResult> {
    return withSubmissionLock(async () => {
      const evidence = await readEvidence(batchId)
      const gate = evaluateGate(evidence)
      const basis = await applyJudgment(batchId)
      if (!basis) {
        return {
          ok: false,
          gate,
          reason:
            evidence.tastings.length === 0
              ? '该批次已无品评记录，结论已清空'
              : formatGateReason(gate)
        }
      }
      return { ok: true, gate, reason: '', conclusion: basis.conclusion, basis }
    })
  }

  /** 对所有有品评记录或已失效的批次重算结论；返回重算批次数 */
  async function syncAllConclusions(): Promise<{ total: number; applied: number; blocked: string[] }> {
    const batchIds = new Set<string>([
      ...tastings.value.map((tasting) => tasting.batchId),
      ...invalidBatches.value.map((batch) => batch.id)
    ])
    let applied = 0
    const blocked: string[] = []
    for (const batchId of batchIds) {
      const result = await syncBatchConclusion(batchId)
      if (result.ok) applied += 1
      else if (result.gate.blocked) blocked.push(batchId)
    }
    return { total: batchIds.size, applied, blocked }
  }

  /** 单批次档案导出的判定汇总 */
  async function archiveSummaryOf(batchId: string): Promise<ArchiveJudgmentSummary | null> {
    return buildArchiveSummary(await readEvidence(batchId))
  }

  /** 管理后台 / 导入后用：按当前依据评估一个批次（不落库） */
  function evaluate(batchId: string) {
    return evaluateBatch(evidenceOf(batchId))
  }

  function storedBasisOf(batchId: string): JudgmentBasis | null {
    const batch = batches.value.find((item) => item.id === batchId)
    return batch ? parseStoredBasis(batch) : null
  }

  /**
   * 依据 watcher：环境或转架在环境页 / 转架页（或别的窗口）补录、签署后，
   * 自动把受影响批次上未复核的结论置为失效（结论不允许沿用旧依据）。
   * 品评自身的写入已在提交锁内连同判定一起完成，这里不再重复比对，避免互相抢写。
   */
  watch(
    [environments, turnings],
    () => {
      const batchIds = new Set<string>([
        ...environments.value.map((item) => item.batchId),
        ...turnings.value.map((item) => item.batchId)
      ])
      batchIds.forEach((batchId) => {
        void invalidateBatch(batchId)
      })
    },
    { deep: true }
  )

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
    avgScore,
    conclusionCounts,
    excellentPercent,
    pendingBatches,
    blockedBatches,
    invalidBatches,
    tastingsOf,
    scoreOf,
    gateOf,
    evaluate,
    storedBasisOf,
    archiveSummaryOf,
    setLastBackupAt,
    markBackupNow,
    patchFilter,
    resetFilter,
    createTasting,
    updateTasting,
    removeTasting,
    applyJudgment,
    syncBatchConclusion,
    syncAllConclusions,
    invalidateBatch
  }
})

export type TastingStore = ReturnType<typeof useTastingStore>
