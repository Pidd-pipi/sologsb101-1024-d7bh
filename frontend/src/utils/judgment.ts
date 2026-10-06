import type { Batch } from '@/types/batch'
import type { Environment } from '@/types/environment'
import type { Turning } from '@/types/turning'
import type {
  BasisEnvItem,
  BasisTurningItem,
  GateCheck,
  GateCheckItem,
  Tasting,
  TastingBasis
} from '@/types/tasting'

/**
 * 出库品评判定链：品评前先核检环境异常处置与转架签署进度（缺项挡下），
 * 通过后才允许按三维均分给出结论；结论携带依据快照，依据事后被改动而未复核即失效。
 *
 * 本模块全部为纯函数，store、数据库迁移与导出共用同一套口径。
 */

/** 依据结构当前版本，写入 TastingBasis.version */
export const BASIS_VERSION = 1

/**
 * 收集某一批次的判定依据：熟成期间的温湿度记录（含补录的越界记录）
 * 与该批次的全部转架 / 翻面 / 擦洗作业。
 */
export interface BatchEvidence {
  batchId: string
  envItems: BasisEnvItem[]
  turningItems: BasisTurningItem[]
  /** 越界记录数 */
  anomalyCount: number
  /** 越界但未填处置措施的记录数 */
  unhandledAnomalyCount: number
  /** 尚未签署（待执行）的作业数 */
  turningPending: number
  /** 依据中最近一条环境 / 转架记录的更新时间 ms */
  evidenceUpdatedAt: number
}

function toEnvItem(record: Environment): BasisEnvItem {
  return {
    id: record.id,
    recordedAt: record.recordedAt,
    tempC: record.tempC,
    humidityPct: record.humidityPct,
    anomaly: record.anomaly,
    action: record.action ?? ''
  }
}

function toTurningItem(turning: Turning): BasisTurningItem {
  return {
    id: turning.id,
    doneAt: turning.doneAt,
    type: turning.type,
    state: turning.state,
    seq: turning.seq
  }
}

/** 从全量记录中汇总一个批次的依据（记录可传全部批次数据，内部按 batchId 过滤） */
export function collectEvidence(
  batchId: string,
  environments: Environment[],
  turnings: Turning[]
): BatchEvidence {
  const envRecords = environments
    .filter((record) => record.batchId === batchId)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
  const turningRecords = turnings
    .filter((turning) => turning.batchId === batchId)
    .sort((a, b) => (a.seq - b.seq !== 0 ? a.seq - b.seq : a.doneAt.localeCompare(b.doneAt)))

  const envItems = envRecords.map(toEnvItem)
  const turningItems = turningRecords.map(toTurningItem)
  const anomalyItems = envItems.filter((item) => item.anomaly)

  let evidenceUpdatedAt = 0
  envRecords.forEach((record) => {
    evidenceUpdatedAt = Math.max(evidenceUpdatedAt, record.updatedAt ?? record.createdAt ?? 0)
  })
  turningRecords.forEach((turning) => {
    evidenceUpdatedAt = Math.max(evidenceUpdatedAt, turning.updatedAt ?? turning.createdAt ?? 0)
  })

  return {
    batchId,
    envItems,
    turningItems,
    anomalyCount: anomalyItems.length,
    unhandledAnomalyCount: anomalyItems.filter((item) => item.action.trim().length === 0).length,
    turningPending: turningItems.filter((item) => item.state === '待执行').length,
    evidenceUpdatedAt
  }
}

/**
 * 判定链核检：品评前必须逐项通过，任一缺项都挡下该批次的品评提交。
 * 1. 熟成期间至少有一条温湿度记录；
 * 2. 越界（异常）温湿度记录必须已填写处置措施——熟成期间补录的越界也不能漏；
 * 3. 转架 / 翻面 / 擦洗作业必须全部签署（已完成或已跳过），不得留待执行。
 */
export function checkGate(evidence: BatchEvidence): GateCheck {
  const items: GateCheckItem[] = []

  const envOk = evidence.envItems.length > 0
  items.push({
    key: 'envRecords',
    label: '熟成环境记录',
    ok: envOk,
    detail: envOk
      ? `已有 ${evidence.envItems.length} 条温湿度记录`
      : '熟成期间没有任何温湿度记录，先补录后再品评'
  })

  const anomalyOk = evidence.unhandledAnomalyCount === 0
  items.push({
    key: 'envAnomalyHandled',
    label: '越界异常已处置',
    ok: anomalyOk,
    detail:
      evidence.anomalyCount === 0
        ? '无越界温湿度记录'
        : anomalyOk
          ? `${evidence.anomalyCount} 条越界记录均已填写处置措施`
          : `${evidence.unhandledAnomalyCount} 条越界温湿度记录尚未填写处置措施`
  })

  const turningOk = evidence.turningItems.length > 0 && evidence.turningPending === 0
  items.push({
    key: 'turningsSigned',
    label: '转架作业已签完',
    ok: turningOk,
    detail:
      evidence.turningItems.length === 0
        ? '没有任何转架 / 翻面 / 擦洗作业记录'
        : evidence.turningPending === 0
          ? `${evidence.turningItems.length} 条作业均已签署（已完成 / 已跳过）`
          : `${evidence.turningPending} / ${evidence.turningItems.length} 条作业尚未签署（仍为待执行）`
  })

  return {
    batchId: evidence.batchId,
    ok: items.every((item) => item.ok),
    items
  }
}

/** djb2 散列：把依据明细串成短指纹，用于事后比对 */
function djb2Hash(input: string): string {
  let hash = 5381
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

/** 环境 + 转架依据的指纹：任一条记录的增删改都会改变 */
export function evidenceFingerprint(evidence: BatchEvidence): string {
  const envPart = evidence.envItems
    .map(
      (item) =>
        `${item.id}@${item.recordedAt}:${item.tempC}/${item.humidityPct}:${item.anomaly ? 1 : 0}:${item.action}`
    )
    .join('|')
  const turningPart = evidence.turningItems
    .map((item) => `${item.id}@${item.doneAt}#${item.seq}:${item.type}:${item.state}`)
    .join('|')
  return djb2Hash(`e[${envPart}]t[${turningPart}]`)
}

/** 同批次品评集合签名：记录增删或评分改动都会改变 */
export function tastingSignature(tastings: Tasting[]): string {
  const part = tastings
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => `${item.id}@${item.updatedAt}:${item.score}`)
    .join('|')
  return djb2Hash(`s[${part}]`)
}

/** 生成一次品评保存 / 复核时要落库的依据快照 */
export function buildBasis(evidence: BatchEvidence, tastingsOfBatch: Tasting[], now: number): TastingBasis {
  return {
    version: BASIS_VERSION,
    fingerprint: evidenceFingerprint(evidence),
    tastingSig: tastingSignature(tastingsOfBatch),
    envCount: evidence.envItems.length,
    anomalyCount: evidence.anomalyCount,
    unhandledAnomalyCount: evidence.unhandledAnomalyCount,
    turningTotal: evidence.turningItems.length,
    turningPending: evidence.turningPending,
    envItems: evidence.envItems.map((item) => ({ ...item })),
    turningItems: evidence.turningItems.map((item) => ({ ...item })),
    evidenceUpdatedAt: evidence.evidenceUpdatedAt,
    reviewedAt: now
  }
}

/** 结论依据的核对结果：valid 为 false 时 invalidReason 给出失效原因 */
export interface BasisStatus {
  valid: boolean
  invalidReason: string
  /** 依据是否缺失（历史 / 导入数据从未复核过） */
  missing: boolean
}

/** 找出环境依据相对复核时快照的改动 */
function diffEnv(basis: TastingBasis, evidence: BatchEvidence): string[] {
  const reasons: string[] = []
  const before = new Map(basis.envItems.map((item) => [item.id, item]))
  const after = new Map(evidence.envItems.map((item) => [item.id, item]))

  for (const item of after.values()) {
    const old = before.get(item.id)
    if (!old) {
      reasons.push(`新增温湿度记录 ${item.recordedAt}（${item.tempC}℃/${item.humidityPct}%${item.anomaly ? '，越界' : ''}）`)
      continue
    }
    if (old.tempC !== item.tempC || old.humidityPct !== item.humidityPct) {
      reasons.push(
        `${item.recordedAt} 温湿度由 ${old.tempC}℃/${old.humidityPct}% 改为 ${item.tempC}℃/${item.humidityPct}%`
      )
    } else if (old.anomaly !== item.anomaly) {
      reasons.push(`${item.recordedAt} 异常标记被改为${item.anomaly ? '越界' : '正常'}`)
    } else if (old.action.trim() !== item.action.trim()) {
      reasons.push(`${item.recordedAt} 越界处置措施已改动`)
    }
  }
  for (const item of before.values()) {
    if (!after.has(item.id)) reasons.push(`温湿度记录 ${item.recordedAt} 已删除`)
  }
  return reasons
}

/** 找出转架进度相对复核时快照的改动 */
function diffTurning(basis: TastingBasis, evidence: BatchEvidence): string[] {
  const reasons: string[] = []
  const before = new Map(basis.turningItems.map((item) => [item.id, item]))
  const after = new Map(evidence.turningItems.map((item) => [item.id, item]))

  for (const item of after.values()) {
    const old = before.get(item.id)
    if (!old) {
      reasons.push(`新增${item.type}作业 ${item.doneAt}（${item.state}）`)
      continue
    }
    if (old.state !== item.state) {
      reasons.push(`${item.doneAt} 的${item.type}作业由「${old.state}」变为「${item.state}」`)
    } else if (old.doneAt !== item.doneAt || old.seq !== item.seq) {
      reasons.push(`${item.type}作业计划（日期 / 顺序）已调整`)
    }
  }
  for (const item of before.values()) {
    if (!after.has(item.id)) reasons.push(`${item.doneAt} 的${item.type}作业已删除`)
  }
  return reasons
}

/**
 * 核对某条品评结论的依据是否仍成立：
 * 依据明细改动、越界处置变化、转架签署进度变化、同批次品评集合变化
 * （新增 / 删除 / 改分）都会令未复核的结论失效。
 */
export function evaluateBasis(
  tasting: Tasting,
  evidence: BatchEvidence,
  tastingsOfBatch: Tasting[]
): BasisStatus {
  const basis = tasting.basis
  if (!basis) {
    return { valid: false, missing: true, invalidReason: '缺少判定依据快照，需重新复核' }
  }

  const reasons: string[] = []
  if (basis.fingerprint !== evidenceFingerprint(evidence)) {
    reasons.push(...diffEnv(basis, evidence), ...diffTurning(basis, evidence))
  }
  if (basis.tastingSig !== tastingSignature(tastingsOfBatch)) {
    reasons.push('同批次品评记录有新增、删除或评分改动')
  }

  if (reasons.length === 0) return { valid: true, missing: false, invalidReason: '' }
  const shown = reasons.slice(0, 5)
  const suffix = reasons.length > shown.length ? ` 等 ${reasons.length} 项改动` : ''
  return { valid: false, missing: false, invalidReason: `依据已改动：${shown.join('；')}${suffix}` }
}

/** 批次判定链在某一时刻的完整结论，供 store 派生与导出复用 */
export interface BatchDecision {
  batchId: string
  /** 最新一条品评（按 updatedAt 倒序），批次结论锚定在它的依据上 */
  anchor: Tasting | null
  gate: GateCheck
  /** 锚定品评的依据核对结果；无品评时为 null */
  anchorBasis: BasisStatus | null
  /** 批次结论是否有效：核检通过且锚定依据未被改动 */
  valid: boolean
  /** 失效 / 挡下原因（valid 为 true 时为空串） */
  invalidReason: string
}

/** 计算一个批次的判定链状态 */
export function decideBatch(
  batchId: string,
  environments: Environment[],
  turnings: Turning[],
  tastings: Tasting[]
): BatchDecision {
  const evidence = collectEvidence(batchId, environments, turnings)
  const gate = checkGate(evidence)
  const ofBatch = tastings.filter((tasting) => tasting.batchId === batchId)
  const anchor =
    ofBatch.slice().sort((a, b) => {
      const diff = b.updatedAt - a.updatedAt
      return diff !== 0 ? diff : b.createdAt - a.createdAt
    })[0] ?? null
  const anchorBasis = anchor ? evaluateBasis(anchor, evidence, ofBatch) : null

  let valid = false
  let invalidReason = ''
  if (!anchor) {
    invalidReason = ''
  } else if (!gate.ok) {
    valid = false
    invalidReason = `判定链核检未通过：${gate.items.filter((item) => !item.ok).map((item) => item.detail).join('；')}`
  } else if (!anchorBasis?.valid) {
    invalidReason = anchorBasis?.invalidReason ?? '依据失效，需重新复核'
  } else {
    valid = true
  }

  return { batchId, anchor, gate, anchorBasis, valid, invalidReason }
}

/** 批次是否存在：批量派生时跳过已删除批次 */
export function decideExistingBatches(
  batches: Batch[],
  environments: Environment[],
  turnings: Turning[],
  tastings: Tasting[]
): Map<string, BatchDecision> {
  const map = new Map<string, BatchDecision>()
  batches.forEach((batch) => {
    map.set(batch.id, decideBatch(batch.id, environments, turnings, tastings))
  })
  return map
}

/** 导出文件中的批次判定摘要：随全量 / 单批次档案一起带出依据状态与失效原因 */
export interface BatchJudgmentSummary {
  batchId: string
  /** 品评锚定记录 id（最近一次提交 / 复核） */
  anchorTastingId: string | null
  /** 同批次品评次数 */
  tastingCount: number
  gateOk: boolean
  /** 判定链核检项明细 */
  gateItems: GateCheckItem[]
  /** 批次回写结论（优 / 合格 / 待改进，无品评时为空串） */
  conclusion: string
  /** 结论是否有效（核检通过且依据未改动） */
  valid: boolean
  /** 失效 / 挡下原因，有效时为空串 */
  invalidReason: string
  /** 锚定依据的复核时间 ms，无依据时为 null */
  reviewedAt: number | null
}

/** 把批次判定结果压成导出摘要 */
export function summarizeDecision(
  decision: BatchDecision,
  tastingsOfBatch: Tasting[],
  conclusion: string
): BatchJudgmentSummary {
  return {
    batchId: decision.batchId,
    anchorTastingId: decision.anchor?.id ?? null,
    tastingCount: tastingsOfBatch.length,
    gateOk: decision.gate.ok,
    gateItems: decision.gate.items,
    conclusion,
    valid: decision.valid,
    invalidReason: decision.invalidReason,
    reviewedAt: decision.anchor?.basis?.reviewedAt ?? null
  }
}
