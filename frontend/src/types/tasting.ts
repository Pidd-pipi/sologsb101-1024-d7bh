/**
 * 出库品评：批次出库（或开箱试吃）时对外观 / 风味 / 质地各维度打分并给结论。
 * 同批次多次品评取均分并回写批次结论（优 / 合格 / 待改进）。
 */
export type TastingConclusion = '优' | '合格' | '待改进'

/** 外观 / 风味 / 质地三个维度的评分字段 */
export type TastingDimension = 'appearanceScore' | 'flavorScore' | 'textureScore'

/** 判定链核检项的唯一键 */
export type GateItemKey = 'envRecords' | 'envAnomalyHandled' | 'turningsSigned'

/** 品评前判定链的单个核检项 */
export interface GateCheckItem {
  key: GateItemKey
  /** 核检项名称 */
  label: string
  /** 是否通过 */
  ok: boolean
  /** 通过或挡下的具体说明（含数量、时间等细节） */
  detail: string
}

/** 批次判定链核检结果：品评提交 / 复核前必须 ok */
export interface GateCheck {
  batchId: string
  /** 全部核检项均通过才为 true；false 时品评必须挡下 */
  ok: boolean
  items: GateCheckItem[]
}

/** 依据快照中的单条环境记录摘要 */
export interface BasisEnvItem {
  id: string
  recordedAt: string
  tempC: number
  humidityPct: number
  anomaly: boolean
  action: string
}

/** 依据快照中的单条转架作业摘要 */
export interface BasisTurningItem {
  id: string
  doneAt: string
  type: string
  state: string
  seq: number
}

/**
 * 品评结论的依据快照：保存 / 复核时按当时的环境异常处置情况、
 * 转架签署进度与同批次品评集合生成；依据事后被改动时，
 * 指纹 / 品评集合签名对不上，结论即判失效、需重新复核。
 */
export interface TastingBasis {
  /** 依据结构版本 */
  version: 1
  /** 环境 + 转架依据指纹（djb2 散列） */
  fingerprint: string
  /** 同批次品评集合签名（id / updatedAt / score） */
  tastingSig: string
  envCount: number
  anomalyCount: number
  /** 越界但未填处置措施的记录数 */
  unhandledAnomalyCount: number
  turningTotal: number
  /** 尚未签署（待执行）的作业数 */
  turningPending: number
  /** 环境依据明细（全部记录，供导出留档） */
  envItems: BasisEnvItem[]
  /** 转架依据明细（全部作业，供导出留档） */
  turningItems: BasisTurningItem[]
  /** 依据中最近一条环境 / 转架记录的更新时间 ms */
  evidenceUpdatedAt: number
  /** 本次复核时间 ms */
  reviewedAt: number
}

export interface Tasting {
  id: string
  /** 所属批次 id（外键 → Batch.id） */
  batchId: string
  /** 出库日期（YYYY-MM-DD） */
  outAt: string
  /** 外观描述 */
  appearance: string
  /** 风味描述 */
  flavor: string
  /** 质地描述 */
  texture: string
  /** 外观评分 1-10 */
  appearanceScore: number
  /** 风味评分 1-10 */
  flavorScore: number
  /** 质地评分 1-10 */
  textureScore: number
  /** 评分 1-10，取三维度均分 */
  score: number
  /** 结论 */
  conclusion: TastingConclusion
  /** 品评人 */
  taster: string
  /** 判定链依据快照（v3 起写入；历史数据迁移补挂，导入的重映射数据置空待复核） */
  basis: TastingBasis | null
  createdAt: number
  updatedAt: number
}

export const TASTING_CONCLUSIONS: TastingConclusion[] = ['优', '合格', '待改进']

export const SCORE_DIMENSIONS: Array<{ key: TastingDimension; label: string; hint: string }> = [
  { key: 'appearanceScore', label: '外观', hint: '表皮颜色、切面气孔与油脂分布' },
  { key: 'flavorScore', label: '风味', hint: '奶香、酸度、咸度与尾韵' },
  { key: 'textureScore', label: '质地', hint: '硬度、弹性与结晶颗粒' }
]

/** 三维度均分 → 总分（保留 1 位小数） */
export function averageScore(
  appearanceScore: number,
  flavorScore: number,
  textureScore: number
): number {
  const values = [appearanceScore, flavorScore, textureScore].map((value) =>
    Math.min(10, Math.max(1, value))
  )
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
}

/** 评分区间 → 结论的默认换算 */
export function scoreToConclusion(score: number): TastingConclusion {
  if (score >= 8.5) return '优'
  if (score >= 6) return '合格'
  return '待改进'
}

/** 品评页筛选条件：关键字 + 批次多选 + 结论多选 */
export interface TastingFilterState {
  keyword: string
  batchIds: string[]
  conclusions: TastingConclusion[]
}

export function createEmptyTastingFilter(): TastingFilterState {
  return {
    keyword: '',
    batchIds: [],
    conclusions: []
  }
}

/** 同批次均分派生值，用于回写批次结论 */
export interface BatchScore {
  batchId: string
  count: number
  /** 均分，保留 1 位小数 */
  avgScore: number
  /** 均分换算出的结论 */
  conclusion: TastingConclusion
  /** 各维度均分 */
  avgAppearance: number
  avgFlavor: number
  avgTexture: number
  /** 最近一次出库日期 */
  lastOutAt: string
}
