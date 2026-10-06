<script setup lang="ts">
import { computed, h, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import {
  CircleCloseFilled,
  Delete,
  Download,
  Edit,
  MagicStick,
  Plus,
  Upload,
  WarningFilled
} from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, {
  type FilterModel,
  type FilterSelectConfig
} from '@/components/common/FilterBar.vue'
import GradeTag from '@/components/common/GradeTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useAgingDays } from '@/hooks/useAgingDays'
import { useMilkStore } from '@/stores/milkStore'
import { useTastingStore, type TastingRow } from '@/stores/tastingStore'
import {
  SCORE_DIMENSIONS,
  TASTING_CONCLUSIONS,
  averageScore,
  createEmptyTastingFilter,
  scoreToConclusion,
  type TastingConclusion
} from '@/types/tasting'
import {
  countAll,
  readStampedDbVersion,
  DB_NAME,
  DB_VERSION,
  resetDatabase
} from '@/utils/db'
import {
  exportBatchArchiveJson,
  exportSnapshotJson,
  importSnapshotJson,
  parseSnapshotJson,
  readFileText,
  remapPayloadIds
} from '@/utils/export'
import { toDateString } from '@/utils/temperature'
import type { JudgmentBasis } from '@/utils/judgement'

const tastingStore = useTastingStore()
const milkStore = useMilkStore()

const { tastings, filteredRows, ready, filter, batchScores, avgScore, conclusionCounts, pendingBatches, invalidBatches } =
  storeToRefs(tastingStore)
const { batches } = storeToRefs(milkStore)

const aging = useAgingDays({ batches: () => milkStore.batches })

const formRef = ref<FormInstance>()
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const overwriteImport = ref(false)
const fileInput = ref<HTMLInputElement>()
const counts = ref<Record<string, number>>({})
const busy = ref(false)

const form = reactive({
  batchId: '',
  outAt: toDateString(new Date()),
  appearance: '',
  flavor: '',
  texture: '',
  appearanceScore: 8,
  flavorScore: 8,
  textureScore: 8,
  taster: ''
})

const rules: FormRules = {
  batchId: [{ required: true, message: '请选择批次', trigger: 'change' }],
  outAt: [{ required: true, message: '请选择出库日期', trigger: 'change' }],
  appearance: [{ required: true, message: '请填写外观描述', trigger: 'blur' }],
  flavor: [{ required: true, message: '请填写风味描述', trigger: 'blur' }],
  texture: [{ required: true, message: '请填写质地描述', trigger: 'blur' }],
  taster: [{ required: true, message: '请填写品评人', trigger: 'blur' }]
}

const formTotal = computed(() =>
  averageScore(form.appearanceScore, form.flavorScore, form.textureScore)
)
const formConclusion = computed(() => scoreToConclusion(formTotal.value))

/** 表单所选批次的判定链闸门：缺项时禁止提交，并列出未处置异常与未签署转架 */
const formGate = computed(() => (form.batchId ? tastingStore.gateOf(form.batchId) : null))

/** 所选批次已落库但已失效的原因（编辑场景提示） */
const formInvalidReason = computed(() => {
  if (!form.batchId) return ''
  const batch = batches.value.find((item) => item.id === form.batchId)
  if (!batch || !batch.judgmentInvalid) return ''
  return batch.judgmentInvalidReason || '判定依据已变化，请复核重算'
})

const tastingFilterModel = computed<FilterModel>(() => ({
  keyword: filter.value.keyword,
  batchIds: [...filter.value.batchIds],
  conclusions: [...filter.value.conclusions]
}))

const tastingSelects = computed<FilterSelectConfig[]>(() => [
  {
    key: 'batchIds',
    label: '批次',
    queryKey: 'batch',
    options: batches.value.map((batch) => ({
      label: `${milkStore.milkNameOf(batch.milkId)} · ${batch.cheeseType} ${batch.curdedAt}`,
      value: batch.id,
      count: tastings.value.filter((tasting) => tasting.batchId === batch.id).length
    }))
  },
  {
    key: 'conclusions',
    label: '结论',
    queryKey: 'conc',
    options: TASTING_CONCLUSIONS.map((conclusion) => ({
      label: conclusion,
      value: conclusion,
      count: conclusionCounts.value[conclusion]
    }))
  }
])

const batchOptions = computed(() =>
  batches.value.map((batch) => ({
    label: `${milkStore.milkNameOf(batch.milkId)} · ${batch.cheeseType} ${batch.curdedAt}（${batch.state}）`,
    value: batch.id
  }))
)

/** 出库预警：已到最早可出库日期但仍未品评的批次 */
const dueWithoutTasting = computed(() =>
  milkStore.batches.filter(
    (batch) =>
      batch.state !== '报废' &&
      !tastings.value.some((tasting) => tasting.batchId === batch.id) &&
      (aging.agingOf(batch)?.remainDays ?? 1) <= 0
  )
)

const stampedVersion = ref(readStampedDbVersion())

async function refreshCounts(): Promise<void> {
  counts.value = await countAll()
}

void refreshCounts()

function applyFilter(model: FilterModel): void {
  tastingStore.patchFilter({
    keyword: model.keyword,
    batchIds: (model.batchIds as string[]) ?? [],
    conclusions: (model.conclusions as TastingConclusion[]) ?? []
  })
}

function resetFilter(): void {
  tastingStore.filter = createEmptyTastingFilter()
}

function openDialog(row?: TastingRow): void {
  if (row) {
    editingId.value = row.tasting.id
    form.batchId = row.tasting.batchId
    form.outAt = row.tasting.outAt
    form.appearance = row.tasting.appearance
    form.flavor = row.tasting.flavor
    form.texture = row.tasting.texture
    form.appearanceScore = row.tasting.appearanceScore
    form.flavorScore = row.tasting.flavorScore
    form.textureScore = row.tasting.textureScore
    form.taster = row.tasting.taster
  } else {
    editingId.value = null
    form.batchId = batches.value[0]?.id ?? ''
    form.outAt = toDateString(new Date())
    form.appearance = ''
    form.flavor = ''
    form.texture = ''
    form.appearanceScore = 8
    form.flavorScore = 8
    form.textureScore = 8
    form.taster = ''
  }
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  // 判定链闸门：缺项（未处置越界记录 / 未签完转架）直接挡下，不允许提交
  const gate = tastingStore.gateOf(form.batchId)
  if (gate.blocked) {
    await ElMessageBox.alert(
      () =>
        h('div', [
          h('p', { style: 'margin:0 0 8px;font-weight:600' }, '品评前判定链核查未通过，本批不能提交品评：'),
          ...gate.unresolvedAnomalies.map((item) =>
            h(
              'p',
              { style: 'margin:4px 0' },
              `· 越界温湿度未处置：${item.recordedAt.replace('T', ' ')}（${item.tempC}℃ / ${item.humidityPct}%），请先到环境页补录措施`
            )
          ),
          ...gate.pendingTurnings.map((item) =>
            h(
              'p',
              { style: 'margin:4px 0' },
              `· 转架作业未签署：${item.type} ${item.doneAt}${item.operator ? `（${item.operator}）` : ''}，请先到转架页签完`
            )
          )
        ]),
      '判定链闸门挡下',
      { type: 'error', confirmButtonText: '去补齐依据' }
    )
    return
  }
  const payload = { ...form }
  if (editingId.value) {
    const result = await tastingStore.updateTasting(editingId.value, payload)
    if (!result.ok) {
      ElMessage.error(result.reason || '品评更新后未能形成批次结论，请先补齐依据')
      return
    }
    ElMessage.success(
      `品评已更新，按最新依据重算均分 ${result.basis?.avgScore ?? formTotal.value} 分（${result.conclusion}），依据已一并存盘`
    )
  } else {
    const result = await tastingStore.createTasting(payload)
    if (!result.ok) {
      ElMessage.error(result.reason || '判定链闸门未通过，品评未保存')
      return
    }
    ElMessage.success(
      `品评已保存，按当前依据成立均分 ${result.basis?.avgScore ?? formTotal.value} 分（${result.conclusion}），依据已一并存盘`
    )
  }
  dialogVisible.value = false
  await refreshCounts()
}

async function remove(row: TastingRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除 ${row.tasting.outAt} 的品评记录（${row.batchLabel}，${row.tasting.score} 分）？删除后会重算该批次结论。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await tastingStore.removeTasting(row.tasting.id)
  ElMessage.success('品评记录已删除，批次结论已重算')
  await refreshCounts()
}

function conclusionOf(row: TastingRow): TastingConclusion {
  return row.tasting.conclusion
}

/** 批次最近一次落库的判定依据快照（含异常数、待签转架数等） */
function basisOf(batchId: string) {
  return tastingStore.storedBasisOf(batchId)
}

/** 单条品评提交时盖的依据章 */
function tastingBasis(tasting: { basis?: string }): JudgmentBasis | null {
  if (!tasting.basis) return null
  try {
    return JSON.parse(tasting.basis) as JudgmentBasis
  } catch {
    return null
  }
}

function basisTooltip(tasting: { basis?: string }): string {
  const basis = tastingBasis(tasting)
  if (!basis) return ''
  return [
    `判定时间：${basis.evaluatedAt.slice(0, 19).replace('T', ' ')}`,
    `品评条数：${basis.tastingCount}，均分：${basis.avgScore}，结论：${basis.conclusion}`,
    `环境异常：${basis.anomalyCount}（未处置 ${basis.unresolvedAnomalyCount}）`,
    `待签转架：${basis.pendingTurningCount}`,
    `依据签名：${basis.signature}`
  ].join('\n')
}

/** 批次结论失效原因（明细表用） */
function batchInvalidReason(batchId: string): string {
  const batch = batches.value.find((item) => item.id === batchId)
  return batch?.judgmentInvalid ? batch.judgmentInvalidReason || '判定依据已变化，结论失效待复核' : ''
}

/** 复核：按最新依据重算结论并连同依据快照回写批次 */
async function writeBack(batchId: string): Promise<void> {
  const result = await tastingStore.syncBatchConclusion(batchId)
  if (result.ok) {
    ElMessage.success(
      `已按最新依据复核：均分 ${result.basis?.avgScore} 分 → 「${result.conclusion}」，依据已重新存盘`
    )
  } else if (result.gate.blocked) {
    ElMessage.error(result.reason)
  } else {
    ElMessage.warning(result.reason || '该批次已无品评记录，结论已清空')
  }
}

async function syncAll(): Promise<void> {
  const result = await tastingStore.syncAllConclusions()
  if (result.total === 0) {
    ElMessage.success('暂无可回写的品评记录')
  } else if (result.blocked.length === 0) {
    ElMessage.success(`已按最新依据重算并回写 ${result.applied} 个批次的结论`)
  } else {
    ElMessage.warning(
      `已复核 ${result.applied} 个批次；${result.blocked.length} 个批次因闸门缺项（未处置异常 / 未签转架）未成立结论`
    )
  }
}

async function exportAll(): Promise<void> {
  busy.value = true
  try {
    const result = await exportSnapshotJson()
    tastingStore.markBackupNow()
    stampedVersion.value = readStampedDbVersion()
    ElMessage.success(
      `已导出 ${result.fileName}（奶源 ${result.counts.milks} / 批次 ${result.counts.batches} / 转架 ${result.counts.turnings} / 环境 ${result.counts.environments} / 品评 ${result.counts.tastings}）`
    )
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导出失败')
  } finally {
    busy.value = false
  }
}

async function exportOneBatch(batchId: string): Promise<void> {
  try {
    const result = await exportBatchArchiveJson(batchId)
    ElMessage.success(`已导出批次档案 ${result.fileName}`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导出失败')
  }
}

function pickFile(): void {
  fileInput.value?.click()
}

async function handleFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  busy.value = true
  try {
    const text = await readFileText(file)
    const parsed = parseSnapshotJson(text)
    if (!parsed.ok || !parsed.payload) {
      ElMessageBox.alert(parsed.errors.join('；'), 'JSON 校验失败', { type: 'error' })
      return
    }
    const payload = overwriteImport.value ? parsed.payload : remapPayloadIds(parsed.payload)
    const result = await importSnapshotJson(payload, overwriteImport.value)
    await refreshCounts()
    const recheck = await tastingStore.syncAllConclusions()
    ElMessage.success(
      `导入完成（${overwriteImport.value ? '覆盖' : '追加'}）：奶源 ${result.milks} / 批次 ${result.batches} / 窖位 ${result.shelves} / 转架 ${result.turnings} / 环境 ${result.environments} / 品评 ${result.tastings}；已按最新依据复核 ${recheck.applied} 个批次，${recheck.blocked.length} 个批次因闸门缺项未成立结论`
    )
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导入失败')
  } finally {
    busy.value = false
    input.value = ''
  }
}

async function resetAll(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '重置将清空本地全部表并重新播种演示数据，此操作不可撤销。是否继续？',
      '重置本地数据',
      { type: 'warning', confirmButtonText: '确认重置', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await resetDatabase()
  await refreshCounts()
  ElMessage.success('本地数据已重置为演示数据')
}
</script>

<template>
  <section>
    <div class="page-title">
      <div>
        <h2>出库品评判定链与档案导出</h2>
        <p>
          品评前先核查环境异常处置与转架签署进度，缺项挡下；结论按均分连同依据一并成立，依据一改动未经复核的结论即失效，复核按最新依据重算。
        </p>
      </div>
      <div>
        <el-button type="primary" :icon="Plus" @click="openDialog()">新建品评</el-button>
        <el-button :icon="MagicStick" @click="syncAll">复核并重算结论</el-button>
        <el-button :icon="Download" :loading="busy" @click="exportAll">导出 JSON</el-button>
        <el-button :icon="Upload" @click="pickFile">导入 JSON</el-button>
        <input
          ref="fileInput"
          class="hidden-input"
          type="file"
          accept="application/json,.json"
          @change="handleFileChange"
        />
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="品评记录" :value="tastings.length" suffix="条" icon="Tickets" />
      <StatBadge label="品评均分" :value="avgScore" suffix="分" icon="Star" tone="primary" />
      <StatBadge label="结论为优" :value="conclusionCounts['优']" suffix="条" icon="CircleCheckFilled" tone="success" />
      <StatBadge label="待改进" :value="conclusionCounts['待改进']" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="覆盖批次" :value="batchScores.length" suffix="批" icon="Files" tone="info" />
      <StatBadge
        label="结论失效待复核"
        :value="invalidBatches.length"
        suffix="批"
        icon="CircleCloseFilled"
        :tone="invalidBatches.length > 0 ? 'danger' : 'success'"
      />
    </div>

    <el-alert
      v-if="invalidBatches.length > 0"
      type="error"
      :closable="false"
      show-icon
      class="alert-gap"
    >
      <div>
        有 {{ invalidBatches.length }} 个批次的结论因依据改动已失效（回写值已清空，未复核不得出库）：
        <el-button
          v-for="batch in invalidBatches"
          :key="batch.id"
          text
          type="primary"
          size="small"
          @click="writeBack(batch.id)"
        >
          复核{{ milkStore.milkNameOf(batch.milkId) }}·{{ batch.cheeseType }}
        </el-button>
      </div>
      <div v-for="batch in invalidBatches" :key="`${batch.id}-reason`" class="invalid-reason">
        {{ milkStore.milkNameOf(batch.milkId) }}·{{ batch.cheeseType }}：{{ batch.judgmentInvalidReason }}
      </div>
    </el-alert>

    <el-alert
      v-if="dueWithoutTasting.length > 0"
      type="warning"
      :closable="false"
      show-icon
      class="alert-gap"
    >
      有 {{ dueWithoutTasting.length }} 个批次已到达最早可出库日期但尚无品评记录：
      {{ dueWithoutTasting.map((batch) => `${milkStore.milkNameOf(batch.milkId)}·${batch.cheeseType}`).join('、') }}
    </el-alert>

    <FilterBar
      :model-value="tastingFilterModel"
      :selects="tastingSelects"
      keyword-placeholder="搜索外观 / 风味 / 质地 / 品评人"
      @update:model-value="applyFilter"
      @reset="resetFilter"
    />

    <div class="section-card">
      <div class="section-card__head">
        <h3>批次判定链：均分 · 依据 · 结论（{{ batchScores.length }}）</h3>
        <span class="muted">
          均分 ≥ 8.5 为优，≥ 6 为合格，其余为待改进；依据含品评 / 越界温湿度 / 转架签署，改动后须复核
        </span>
      </div>
      <EmptyPanel
        v-if="ready && batchScores.length === 0"
        compact
        title="暂无批次均分"
        description="录入品评记录后，这里会按批次汇总各维度均分、判定依据与结论。"
        action-text="新建品评"
        @action="openDialog()"
      />
      <el-table v-else :data="batchScores" border stripe>
        <el-table-column label="批次" min-width="220">
          <template #default="{ row }">
            {{ milkStore.milkNameOf(batches.find((batch) => batch.id === row.batchId)?.milkId ?? '') }}
            · {{ batches.find((batch) => batch.id === row.batchId)?.cheeseType ?? '批次已删除' }}
            {{ batches.find((batch) => batch.id === row.batchId)?.curdedAt ?? '' }}
          </template>
        </el-table-column>
        <el-table-column prop="count" label="品评次数" width="90" />
        <el-table-column label="外观均分" width="90">
          <template #default="{ row }"><span class="mono">{{ row.avgAppearance }}</span></template>
        </el-table-column>
        <el-table-column label="风味均分" width="90">
          <template #default="{ row }"><span class="mono">{{ row.avgFlavor }}</span></template>
        </el-table-column>
        <el-table-column label="质地均分" width="90">
          <template #default="{ row }"><span class="mono">{{ row.avgTexture }}</span></template>
        </el-table-column>
        <el-table-column label="均分" width="80">
          <template #default="{ row }">
            <span class="mono">{{ row.avgScore }}</span>
          </template>
        </el-table-column>
        <el-table-column label="判定依据" min-width="200">
          <template #default="{ row }">
            <div class="basis-line">
              <el-tag size="small" :type="row.blocked ? 'danger' : 'info'" effect="plain">
                异常 {{ basisOf(row.batchId)?.anomalyCount ?? 0 }}
              </el-tag>
              <el-tag size="small" :type="row.blocked ? 'danger' : 'info'" effect="plain">
                未处置 {{ basisOf(row.batchId)?.unresolvedAnomalyCount ?? 0 }}
              </el-tag>
              <el-tag size="small" :type="row.blocked ? 'danger' : 'info'" effect="plain">
                待签转架 {{ basisOf(row.batchId)?.pendingTurningCount ?? 0 }}
              </el-tag>
            </div>
            <div v-if="row.invalidReason" class="invalid-reason">{{ row.invalidReason }}</div>
            <div v-else-if="basisOf(row.batchId)" class="muted basis-time">
              依据存于 {{ basisOf(row.batchId)?.evaluatedAt.slice(0, 19).replace('T', ' ') }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="实时结论" width="120">
          <template #default="{ row }">
            <GradeTag :conclusion="row.conclusion" :score="row.avgScore" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="判定状态" width="140">
          <template #default="{ row }">
            <el-tooltip
              v-if="!row.valid"
              :content="row.invalidReason || '依据未复核或闸门缺项'"
              placement="top"
            >
              <el-tag type="danger" effect="dark" size="small">
                <el-icon style="vertical-align: -2px"><CircleCloseFilled /></el-icon>
                {{ row.blocked ? '闸门挡下' : '失效待复核' }}
              </el-tag>
            </el-tooltip>
            <el-tag v-else type="success" effect="dark" size="small">
              <el-icon style="vertical-align: -2px"><CircleCheckFilled /></el-icon>
              依据有效
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="批次回写值" width="120">
          <template #default="{ row }">
            <el-tag :type="row.conclusion === '优' ? 'success' : row.conclusion === '合格' ? 'primary' : 'danger'" effect="plain">
              {{ batches.find((batch) => batch.id === row.batchId)?.conclusion || '未回写' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近出库" width="110">
          <template #default="{ row }">{{ row.lastOutAt || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button text type="primary" @click="writeBack(row.batchId)">
              {{ row.valid ? '复核重算' : '复核成立' }}
            </el-button>
            <el-button text :icon="Download" @click="exportOneBatch(row.batchId)">导出批次</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>品评明细（{{ filteredRows.length }} / {{ tastings.length }}）</h3>
        <span class="muted">三维 1-10 分，总分取三维平均并据此给出结论</span>
      </div>

      <EmptyPanel
        v-if="ready && filteredRows.length === 0"
        title="还没有品评记录"
        description="批次出库后录入外观 / 风味 / 质地打分，系统自动算均分并回写批次结论。"
        action-text="新建品评"
        @action="openDialog()"
      />
      <el-table v-else :data="filteredRows" border stripe>
        <el-table-column label="批次" min-width="200">
          <template #default="{ row }">
            <div>{{ row.batchLabel }}</div>
            <span class="muted">{{ row.milkLabel }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="tasting.outAt" label="出库日期" width="120" />
        <el-table-column prop="tasting.appearance" label="外观" min-width="170" show-overflow-tooltip />
        <el-table-column prop="tasting.flavor" label="风味" min-width="170" show-overflow-tooltip />
        <el-table-column prop="tasting.texture" label="质地" min-width="170" show-overflow-tooltip />
        <el-table-column label="三维评分" width="170">
          <template #default="{ row }">
            <span class="mono">
              {{ row.tasting.appearanceScore }} / {{ row.tasting.flavorScore }} /
              {{ row.tasting.textureScore }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="评分" width="90">
          <template #default="{ row }">
            <span class="mono">{{ row.tasting.score }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结论" width="130">
          <template #default="{ row }">
            <GradeTag :conclusion="conclusionOf(row)" :score="row.tasting.score" size="small" plain />
          </template>
        </el-table-column>
        <el-table-column label="判定依据 / 失效原因" min-width="220">
          <template #default="{ row }">
            <el-tooltip
              v-if="tastingBasis(row.tasting)"
              :content="basisTooltip(row.tasting)"
              placement="top"
            >
              <el-tag size="small" effect="plain" type="info">
                依据 {{ tastingBasis(row.tasting)?.tastingCount }} 条品评 · 均分
                {{ tastingBasis(row.tasting)?.avgScore }} · 异常
                {{ tastingBasis(row.tasting)?.anomalyCount }} · 待签
                {{ tastingBasis(row.tasting)?.pendingTurningCount }}
              </el-tag>
            </el-tooltip>
            <el-tag v-else size="small" type="warning" effect="plain">判定链接入前记录，无依据快照</el-tag>
            <div v-if="batchInvalidReason(row.tasting.batchId)" class="invalid-reason">
              {{ batchInvalidReason(row.tasting.batchId) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="tasting.taster" label="品评人" width="110" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button text :icon="Edit" @click="openDialog(row)">编辑</el-button>
            <el-button text type="danger" :icon="Delete" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>本地数据与备份</h3>
        <span class="muted">数据库 {{ DB_NAME }} · 结构版本 v{{ DB_VERSION }}（本地记录 v{{ stampedVersion }}）</span>
      </div>

      <div class="stat-row">
        <StatBadge label="奶源" :value="counts.milks ?? 0" suffix="条" icon="Files" size="small" />
        <StatBadge label="批次" :value="counts.batches ?? 0" suffix="条" icon="Grid" size="small" />
        <StatBadge label="窖位" :value="counts.shelves ?? 0" suffix="条" icon="Box" size="small" />
        <StatBadge label="转架作业" :value="counts.turnings ?? 0" suffix="条" icon="Tickets" size="small" />
        <StatBadge label="环境记录" :value="counts.environments ?? 0" suffix="条" icon="Odometer" size="small" />
        <StatBadge label="品评记录" :value="counts.tastings ?? 0" suffix="条" icon="Star" size="small" />
      </div>

      <el-descriptions :column="2" border class="desc-gap">
        <el-descriptions-item label="数据库名">{{ DB_NAME }}</el-descriptions-item>
        <el-descriptions-item label="结构版本">v{{ DB_VERSION }}（含 version(2).upgrade 迁移）</el-descriptions-item>
        <el-descriptions-item label="最近导出">
          {{ tastingStore.lastBackupAt ? tastingStore.lastBackupAt.slice(0, 19).replace('T', ' ') : '尚未导出' }}
        </el-descriptions-item>
        <el-descriptions-item label="待品评批次">{{ pendingBatches.length }} 批</el-descriptions-item>
        <el-descriptions-item label="失效待复核批次">
          <span :class="invalidBatches.length > 0 ? 'danger-text' : ''">{{ invalidBatches.length }} 批</span>
        </el-descriptions-item>
      </el-descriptions>

      <div class="backup-actions">
        <el-checkbox v-model="overwriteImport">导入时覆盖（勾选=先清空全部表，不勾选=重新分配 id 追加）</el-checkbox>
        <el-button type="primary" :icon="Download" :loading="busy" @click="exportAll">导出全量 JSON</el-button>
        <el-button :icon="Upload" :loading="busy" @click="pickFile">导入 JSON</el-button>
        <el-button :icon="MagicStick" @click="refreshCounts">刷新统计</el-button>
        <el-button type="danger" :icon="Delete" @click="resetAll">重置并重新播种</el-button>
      </div>
      <p class="muted">
        导入文件会先校验 app 字段、各集合数组与父子引用完整性；校验失败会提示具体原因并且不写入任何数据。
      </p>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑品评记录' : '新建品评记录'"
      width="640px"
      destroy-on-close
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="批次" prop="batchId">
          <el-select v-model="form.batchId" filterable placeholder="选择批次" style="width: 100%">
            <el-option
              v-for="option in batchOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="出库日期" prop="outAt">
          <el-date-picker
            v-model="form.outAt"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择出库日期"
            style="width: 100%"
          />
        </el-form-item>

        <el-divider content-position="left">外观</el-divider>
        <el-form-item label="外观描述" prop="appearance">
          <el-input v-model="form.appearance" placeholder="表皮颜色、切面气孔与油脂分布" />
        </el-form-item>
        <el-form-item label="外观评分">
          <el-rate v-model="form.appearanceScore" :max="10" show-score score-template="{value} 分" />
        </el-form-item>

        <el-divider content-position="left">风味</el-divider>
        <el-form-item label="风味描述" prop="flavor">
          <el-input v-model="form.flavor" placeholder="奶香、酸度、咸度与尾韵" />
        </el-form-item>
        <el-form-item label="风味评分">
          <el-slider v-model="form.flavorScore" :min="1" :max="10" :step="0.5" show-input />
        </el-form-item>

        <el-divider content-position="left">质地</el-divider>
        <el-form-item label="质地描述" prop="texture">
          <el-input v-model="form.texture" placeholder="硬度、弹性与结晶颗粒" />
        </el-form-item>
        <el-form-item label="质地评分">
          <el-input-number v-model="form.textureScore" :min="1" :max="10" :step="0.5" :precision="1" />
        </el-form-item>

        <el-form-item label="品评人" prop="taster">
          <el-input v-model="form.taster" placeholder="如：林岚" clearable />
        </el-form-item>

        <el-divider content-position="left">品评前判定链核查</el-divider>
        <el-alert
          v-if="formGate && formGate.blocked"
          type="error"
          :closable="false"
          show-icon
          class="gate-alert"
        >
          <template #title>闸门未放行，缺项补齐前本批不能提交品评：</template>
          <div v-for="item in formGate.unresolvedAnomalies" :key="item.id" class="gate-line">
            <el-icon><WarningFilled /></el-icon>
            越界温湿度未处置：{{ item.recordedAt.replace('T', ' ') }}（{{ item.tempC }}℃ /
            {{ item.humidityPct }}%），请到环境页补录处置措施
          </div>
          <div v-for="item in formGate.pendingTurnings" :key="item.id" class="gate-line">
            <el-icon><WarningFilled /></el-icon>
            {{ item.type }}作业未签署：{{ item.doneAt }}{{ item.operator ? `（${item.operator}）` : '' }}，请到转架页签完
          </div>
        </el-alert>
        <el-alert v-else type="success" :closable="false" show-icon class="gate-alert">
          <template #title>判定链核查通过</template>
          <div class="muted">
            环境异常 {{ formGate?.anomalies.length ?? 0 }} 条（均已补录处置）、待签转架
            {{ formGate?.pendingTurnings.length ?? 0 }} 条；提交后按均分连同依据成立结论。
          </div>
          <div v-for="notice in formGate?.notices ?? []" :key="notice" class="gate-notice">· {{ notice }}</div>
        </el-alert>
        <el-alert
          v-if="formInvalidReason && !(formGate && formGate.blocked)"
          type="warning"
          :closable="false"
          show-icon
          class="gate-alert"
          title="该批次旧结论已失效，本次保存即按最新依据复核重算"
          :description="formInvalidReason"
        />

        <el-alert
          :type="formGate?.blocked ? 'info' : 'success'"
          :closable="false"
          show-icon
          class="gate-alert"
        >
          三维均分 {{ formTotal }} 分 → 结论「{{ formConclusion }}」，
          {{ formGate?.blocked ? '但闸门缺项，保存会被挡下。' : '保存后连同判定依据一起回写批次。' }}
          <span class="muted">
            （{{ SCORE_DIMENSIONS.map((item) => item.label).join(' / ') }} 各占 1/3 权重）
          </span>
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="formGate?.blocked" @click="submit">
          {{ formGate?.blocked ? '依据缺项，禁止提交' : '保存并连同依据成立结论' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.hidden-input {
  display: none;
}

.alert-gap {
  margin-bottom: 16px;
}

.invalid-reason {
  margin-top: 4px;
  font-size: 12px;
  line-height: 18px;
  color: #c0392b;
}

.danger-text {
  color: #c0392b;
  font-weight: 600;
}

.basis-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.basis-time {
  margin-top: 4px;
  font-size: 12px;
}

.gate-alert {
  margin-top: 4px;
  margin-bottom: 12px;
}

.gate-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 13px;
  line-height: 18px;
}

.gate-notice {
  margin-top: 2px;
  font-size: 12px;
}

.desc-gap {
  margin-bottom: 12px;
}

.backup-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
</style>
