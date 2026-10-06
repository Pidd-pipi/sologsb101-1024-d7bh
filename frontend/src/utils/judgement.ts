/**
 * 出库品评判定链：
 * 品评前先核查批次的环境异常处置与转架签署进度（闸门），缺项挡下；
 * 通过后按同批次全部品评的均分给出结论，并连同依据快照、依据签名一起落库。
 * 依据（品评 / 环境 / 转架）一旦改动，签名不再匹配，未经复核的结论即失效，需要重算。
 */
import type { Batch } from '@/types/batch'
import type { Environment } from '@/types/environment'
import type { Tasting, TastingConclusion } from '@/types/tasting'
import type { Turning } from '@/types/turning'
import { scoreToConclusion as toConclusion } from '@/types/tasting'
import { round } from '@/utils/temperature'

/** 判定状态：有效（依据未变）/ 失效（依据已改动，待复核重算）/ 无结论 */
export type JudgmentStatus = 'valid' | 'invalid' | 'none'

/** 一条环境异常依据 */
export interface AnomalyEvidence {
  id: string
  recordedAt: string
  tempC: number
  humidityPct: number
  action: string
  /** 是否已处置：异常记录填了调整措施视为已处置 */
  resolved: boolean
}

/** 一条未签署完的转架作业依据 */
export interface PendingTurningEvidence {
  id: string
  doneAt: string
  type: Turning['type']
  operator: string
  seq: number
}

/** 判定依据：闸门结果 + 均分汇总，落库时序列化为快照 */
export interface JudgmentBasis {
  /** 依据生成时间（ISO 字符串） */
  evaluatedAt: string
  /** 参与均分的品评条数 */
  tastingCount: number
  /** 同批次品评均分（保留 1 位小数） */
  avgScore: number
  /** 均分换算的结论 */
  conclusion: TastingConclusion | ''
  /** 熟成期内的环境异常条数 */
  anomalyCount: number
  /** 尚未处置（未填措施）的异常条数 */
  unresolvedAnomalyCount: number
  /** 待签署（待执行）的转架作业条数 */
  pendingTurningCount: number
  /** 依据签名：品评 / 环境 / 转架关键字段的稳定指纹 */
  signature: string
}

/** 闸门核查结果：blocked 为 true 时不允许提交品评 */
export interface BatchGate {
  batchId: string
  /** 是否有缺项（未处置异常或未签完的转架） */
  blocked: boolean
  anomalies: AnomalyEvidence[]
  unresolvedAnomalies: AnomalyEvidence[]
  pendingTurnings: PendingTurningEvidence[]
  /** 不挡下但需要提示的事项（如异常已处置、转架已跳过） */
  notices: string[]
}

/** 判定链一次完整评估的结果 */
export interface BatchEvaluation {
  gate: BatchGate
  basis: JudgmentBasis | null
  /** 按当前依据算出的结论（无品评时为空串） */
  conclusion: TastingConclusion | ''
  avgScore: number
  tastingCount: number
}

export interface BatchEvidenceInput {
  batch?: Batch
  environments: Environment[]
  turnings: Turning[]
  tastings: Tasting[]
}

/** 异常是否已处置：越界记录补录了调整措施即视为闭环 */
export function isAnomalyResolved(record: Environment): boolean {
  return record.anomaly && record.action.trim().length > 0
}

/** 转架作业是否算「签完」：已完成 / 已跳过都是终态，待执行即缺项 */
export function isTurningSigned(turning: Turning): boolean {
  return turning.state === '已完成' || turning.state === '已跳过'
}

/** 取批次的全部环境异常依据 */
export function anomalyEvidenceOf(environments: Environment[]): AnomalyEvidence[] {
  return environments
    .filter((record) => record.anomaly)
    .map((record) => ({
      id: record.id,
      recordedAt: record.recordedAt,
      tempC: record.tempC,
      humidityPct: record.humidityPct,
      action: record.action,
      resolved: isAnomalyResolved(record)
    }))
}

/** 取批次未签署完的转架作业依据，按计划序号升序 */
export function pendingTurningEvidenceOf(turnings: Turning[]): PendingTurningEvidence[] {
  return turnings
    .filter((turning) => !isTurningSigned(turning))
    .sort((a, b) => a.seq - b.seq || a.doneAt.localeCompare(b.doneAt))
    .map((turning) => ({
      id: turning.id,
      doneAt: turning.doneAt,
      type: turning.type,
      operator: turning.operator,
      seq: turning.seq
    }))
}

/** 品评前闸门：核查环境异常处置与转架签署进度，任一缺项即 blocked */
export function evaluateGate(input: BatchEvidenceInput): BatchGate {
  const batchId = input.batch?.id ?? ''
  const anomalies = anomalyEvidenceOf(input.environments)
  const unresolvedAnomalies = anomalies.filter((item) => !item.resolved)
  const pendingTurnings = pendingTurningEvidenceOf(input.turnings)
  const notices: string[] = []
  const resolvedCount = anomalies.length - unresolvedAnomalies.length
  if (resolvedCount > 0) {
    notices.push(`${resolvedCount} 条环境异常已补录处置措施`)
  }
  const skippedCount = input.turnings.filter((turning) => turning.state === '已跳过').length
  if (skippedCount > 0) {
    notices.push(`${skippedCount} 条转架作业已跳过签署`)
  }
  return {
    batchId,
    blocked: unresolvedAnomalies.length > 0 || pendingTurnings.length > 0,
    anomalies,
    unresolvedAnomalies,
    pendingTurnings,
    notices
  }
}

/**
 * 依据签名：只取参与判定的关键字段，环境/转架/品评一有改动签名即变。
 * 记录按 id 排序后做稳定 JSON 串，再叠加一层简易散列，避免签名直接等于明文。
 */
export function computeBasisSignature(input: BatchEvidenceInput): string {
  const tastingDigest = input.tastings
    .map((item) => ({
      id: item.id,
      s: item.score,
      a: item.appearanceScore,
      f: item.flavorScore,
      t: item.textureScore
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const envDigest = input.environments
    .map((item) => ({
      id: item.id,
      at: item.recordedAt,
      temp: item.tempC,
      hum: item.humidityPct,
      anomaly: item.anomaly,
      action: item.action
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const turningDigest = input.turnings
    .map((item) => ({
      id: item.id,
      at: item.doneAt,
      type: item.type,
      state: item.state,
      seq: item.seq
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const json = JSON.stringify({ tastingDigest, envDigest, turningDigest })
  return hashString(json)
}

/** 32 位 FNV-1a 散列，输出 16 进制（同输入恒定同输出） */
export function hashString(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 按当前依据构建判定快照（闸门缺项或无品评时返回 null） */
export function buildBasis(
  input: BatchEvidenceInput,
  evaluatedAt = new Date().toISOString()
): JudgmentBasis | null {
  if (input.tastings.length === 0) return null
  const gate = evaluateGate(input)
  if (gate.blocked) return null
  const avgScore = round(
    input.tastings.reduce((sum, item) => sum + item.score, 0) / input.tastings.length,
    1
  )
  return {
    evaluatedAt,
    tastingCount: input.tastings.length,
    avgScore,
    conclusion: toConclusion(avgScore),
    anomalyCount: gate.anomalies.length,
    unresolvedAnomalyCount: gate.unresolvedAnomalies.length,
    pendingTurningCount: gate.pendingTurnings.length,
    signature: computeBasisSignature(input)
  }
}

/** 汇总评估：闸门 + 按最新依据算出的均分结论 */
export function evaluateBatch(input: BatchEvidenceInput): BatchEvaluation {
  const gate = evaluateGate(input)
  const avgScore =
    input.tastings.length === 0
      ? 0
      : round(
          input.tastings.reduce((sum, item) => sum + item.score, 0) / input.tastings.length,
          1
        )
  const conclusion: TastingConclusion | '' =
    input.tastings.length === 0 ? '' : toConclusion(avgScore)
  return {
    gate,
    basis: buildBasis(input),
    conclusion,
    avgScore,
    tastingCount: input.tastings.length
  }
}

/** 批次上一次判定状态：无结论 / 有效 / 失效（依据已改动，没复核） */
export function judgmentStatusOf(batch: Batch): JudgmentStatus {
  // 失效时批次回写结论会被清空，必须先认失效标记
  if (batch.judgmentInvalid) return 'invalid'
  if (!batch.conclusion) return 'none'
  if (!batch.judgmentBasisSignature) return 'invalid'
  return 'valid'
}

/** 失效原因文案：优先取落库原因，兜底按通用依据变更说明 */
export function invalidReasonOf(batch: Batch): string {
  return batch.judgmentInvalidReason || '判定依据已发生变化（品评 / 环境 / 转架），结论未经复核'
}

/** 解析批次上落库的判定依据快照，损坏或缺失时返回 null */
export function parseStoredBasis(batch: Batch): JudgmentBasis | null {
  if (!batch.judgmentBasis) return null
  try {
    const parsed = JSON.parse(batch.judgmentBasis) as Partial<JudgmentBasis>
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.signature !== 'string'
    ) {
      return null
    }
    return parsed as JudgmentBasis
  } catch {
    return null
  }
}

/** 组装单批次档案导出用的判定链汇总 */
export function buildArchiveSummary(input: BatchEvidenceInput): ArchiveJudgmentSummary | null {
  const batch = input.batch
  if (!batch) return null
  const status = judgmentStatusOf(batch)
  return {
    status,
    statusLabel: JUDGMENT_STATUS_LABEL[status],
    batchConclusion: batch.conclusion,
    invalidReason: status === 'invalid' ? invalidReasonOf(batch) : '',
    storedBasis: parseStoredBasis(batch),
    current: evaluateBatch(input)
  }
}

export const JUDGMENT_STATUS_LABEL: Record<JudgmentStatus, string> = {
  valid: '依据有效',
  invalid: '结论失效待复核',
  none: '未判定'
}

/** 单批次档案导出用的判定链汇总（依据 + 失效原因都要带出） */
export interface ArchiveJudgmentSummary {
  /** 当前批次结论是否有效 */
  status: JudgmentStatus
  statusLabel: string
  /** 批次上回写的结论（可能已失效） */
  batchConclusion: string
  /** 结论失效原因，有效或无结论时为空串 */
  invalidReason: string
  /** 落库时的判定依据，未判定过为 null */
  storedBasis: JudgmentBasis | null
  /** 按当前数据重算的闸门与均分结论 */
  current: BatchEvaluation
}
