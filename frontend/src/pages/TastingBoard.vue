<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import {
  CircleCheckFilled,
  Delete,
  Download,
  Edit,
  MagicStick,
  Plus,
  RefreshRight,
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
import { GateBlockedError, useTastingStore, type TastingRow } from '@/stores/tastingStore'
import {
  SCORE_DIMENSIONS,
  TASTING_CONCLUSIONS,
  averageScore,
  createEmptyTastingFilter,
  scoreToConclusion,
  type GateCheck,
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

const tastingStore = useTastingStore()
const milkStore = useMilkStore()

const {
  tastings,
  filteredRows,
  ready,
  filter,
  batchScores,
  avgScore,
  conclusionCounts,
  pendingBatches,
  invalidTastingCount,
  invalidBatchCount
} = storeToRefs(tastingStore)
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

/** 对话框当前批次的判定链核检结果：缺项时硬挡下，不允许提交品评 */
const formGate = computed<GateCheck | null>(() =>
  form.batchId ? tastingStore.gateOf(form.batchId) : null
)
const formGateBlocked = computed(() => formGate.value !== null && !formGate.value.ok)

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
  // 判定链核检：缺项（环境异常未处置、转架未签完等）直接挡下
  if (formGateBlocked.value) {
    ElMessage.error(formGate.value?.items.filter((item) => !item.ok).map((item) => item.detail).join('；'))
    return
  }
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  try {
    if (editingId.value) {
      await tastingStore.updateTasting(editingId.value, { ...form })
      ElMessage.success(`品评已更新，已按最新依据复核，均分 ${formTotal.value} 分（${formConclusion.value}）并重算批次结论`)
    } else {
      await tastingStore.createTasting({ ...form })
      ElMessage.success(`品评已保存，判定链通过，均分 ${formTotal.value} 分（${formConclusion.value}）连同依据一起回写批次结论`)
    }
  } catch (err) {
    if (err instanceof GateBlockedError) {
      ElMessage.error(err.message)
      return
    }
    throw err
  }
  dialogVisible.value = false
  await refreshCounts()
}

async function remove(row: TastingRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除 ${row.tasting.outAt} 的品评记录（${row.batchLabel}，${row.tasting.score} 分）？删除后按剩余品评重算该批次结论，其余结论将因品评集合变化转为待复核。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await tastingStore.removeTasting(row.tasting.id)
  ElMessage.success('品评记录已删除，批次结论已重算（依据变动时需重新复核）')
  await refreshCounts()
}

function conclusionOf(row: TastingRow): TastingConclusion {
  return row.tasting.conclusion
}

function formatReviewedAt(ms: number | null | undefined): string {
  if (!ms) return '未复核'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/** 复核单条品评：按最新依据重算并重新落快照 */
async function reviewRow(row: TastingRow): Promise<void> {
  try {
    await tastingStore.reviewTasting(row.tasting.id)
    ElMessage.success('已按最新依据复核并重算结论')
  } catch (err) {
    if (err instanceof GateBlockedError) ElMessage.error(err.message)
    else throw err
  }
}

/** 复核整个批次：以最新依据重锚定最近一次品评 */
async function reviewBatch(batchId: string): Promise<void> {
  try {
    const result = await tastingStore.reviewBatch(batchId)
    if (result.count === 0) ElMessage.warning('该批次已无品评记录，结论已清空')
    else ElMessage.success(`已按最新依据复核，结论「${result.conclusion}」生效`)
  } catch (err) {
    if (err instanceof GateBlockedError) ElMessage.error(err.message)
    else throw err
  }
}

async function reviewAll(): Promise<void> {
  const result = await tastingStore.reviewAllBatches()
  if (result.blocked.length === 0) {
    ElMessage.success(result.reviewed === 0 ? '暂无可复核的品评记录' : `已按最新依据复核 ${result.reviewed} 个批次的结论`)
    return
  }
  ElMessageBox.alert(
    `已复核 ${result.reviewed} 个批次；${result.blocked.length} 个批次因判定链缺项被挡下：${result.blocked
      .map((item) => item.reason)
      .join('；')}`,
    '部分批次未通过核检',
    { type: 'warning' }
  )
}

async function exportAll(): Promise<void> {
  busy.value = true
  try {
    const result = await exportSnapshotJson()
    tastingStore.markBackupNow()
    stampedVersion.value = readStampedDbVersion()
    ElMessage.success(
      `已导出 ${result.fileName}（奶源 ${result.counts.milks} / 批次 ${result.counts.batches} / 转架 ${result.counts.turnings} / 环境 ${result.counts.environments} / 品评 ${result.counts.tastings}，含判定依据与失效原因）`
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
    ElMessage.success(`已导出批次档案 ${result.fileName}（含判定依据与失效原因）`)
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
    const appendMode = !overwriteImport.value
    const payload = appendMode ? remapPayloadIds(parsed.payload) : parsed.payload
    const result = await importSnapshotJson(payload, overwriteImport.value)
    await refreshCounts()
    if (appendMode) {
      ElMessage.success(
        `追加导入完成（奶源 ${result.milks} / 批次 ${result.batches} / 窖位 ${result.shelves} / 转架 ${result.turnings} / 环境 ${result.environments} / 品评 ${result.tastings}）。导入品评缺判定依据，需逐批复核后方可生效。`
      )
    } else {
      ElMessage.success(
        `覆盖导入完成（奶源 ${result.milks} / 批次 ${result.batches} / 窖位 ${result.shelves} / 转架 ${result.turnings} / 环境 ${result.environments} / 品评 ${result.tastings}）。依据与当前库一致的结论保持有效，其余请复核。`
      )
    }
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

function decisionTagType(valid: boolean): 'success' | 'danger' | 'warning' {
  return valid ? 'success' : 'danger'
}
</script>

<template>
  <section>
    <div class="page-title">
      <div>
        <h2>出库品评判定链与档案导出</h2>
        <p>品评前先核检环境异常处置与转架签署进度（缺项挡下）；结论按三维均分连同依据一起给出，依据改动后未复核的结论自动失效。</p>
      </div>
      <div>
        <el-button type="primary" :icon="Plus" @click="openDialog()">新建品评</el-button>
        <el-button :icon="RefreshRight" @click="reviewAll">批量复核结论</el-button>
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
        label="失效待复核结论"
        :value="invalidBatchCount"
        suffix="批"
        icon="WarningFilled"
        :tone="invalidBatchCount > 0 ? 'danger' : 'success'"
      />
      <StatBadge
        label="可达出库未品评"
        :value="dueWithoutTasting.length"
        suffix="批"
        icon="AlarmClock"
        tone="warning"
      />
    </div>

    <el-alert
      v-if="invalidBatchCount > 0"
      type="error"
      :closable="false"
      show-icon
      class="alert-gap"
    >
      有 {{ invalidBatchCount }} 个批次的品评结论因判定链缺项或依据被改动而失效（{{ invalidTastingCount }} 条品评待复核），
      批次不得按旧结论出库，请处理环境异常 / 转架签署后点击「批量复核结论」。
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
        <h3>批次判定链与结论（{{ batchScores.length }}）</h3>
        <span class="muted">均分 ≥ 8.5 为优，≥ 6 为合格；核检通过且依据未改动，结论方为有效</span>
      </div>
      <EmptyPanel
        v-if="ready && batchScores.length === 0"
        compact
        title="暂无批次均分"
        description="录入品评记录后，这里会按批次展示判定链核检、各维度均分与结论有效性。"
        action-text="新建品评"
        @action="openDialog()"
      />
      <el-table v-else :data="batchScores" border stripe>
        <el-table-column label="批次" min-width="200">
          <template #default="{ row }">
            {{ milkStore.milkNameOf(batches.find((batch) => batch.id === row.batchId)?.milkId ?? '') }}
            · {{ batches.find((batch) => batch.id === row.batchId)?.cheeseType ?? '批次已删除' }}
            {{ batches.find((batch) => batch.id === row.batchId)?.curdedAt ?? '' }}
          </template>
        </el-table-column>
        <el-table-column prop="count" label="品评次数" width="90" />
        <el-table-column label="均分" width="80">
          <template #default="{ row }"><span class="mono">{{ row.avgScore }}</span></template>
        </el-table-column>
        <el-table-column label="结论" width="110">
          <template #default="{ row }">
            <GradeTag :conclusion="row.conclusion" :score="row.avgScore" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="判定链核检" min-width="250">
          <template #default="{ row }">
            <div v-if="tastingStore.decisionOf(row.batchId)" class="gate-list">
              <div
                v-for="item in tastingStore.decisionOf(row.batchId)!.gate.items"
                :key="item.key"
                class="gate-item"
              >
                <el-icon :color="item.ok ? '#1e8449' : '#c0392b'" class="gate-item__icon">
                  <CircleCheckFilled v-if="item.ok" />
                  <WarningFilled v-else />
                </el-icon>
                <span :class="{ 'gate-item--fail': !item.ok }">{{ item.label }}：{{ item.detail }}</span>
              </div>
            </div>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="依据与效力" min-width="230">
          <template #default="{ row }">
            <template v-if="tastingStore.decisionOf(row.batchId)?.anchor">
              <el-tag :type="decisionTagType(tastingStore.decisionOf(row.batchId)!.valid)" size="small" effect="dark">
                {{ tastingStore.decisionOf(row.batchId)!.valid ? '依据有效' : '已失效·待复核' }}
              </el-tag>
              <div class="muted basis-time">
                复核于 {{ formatReviewedAt(tastingStore.decisionOf(row.batchId)!.anchor?.basis?.reviewedAt) }}
              </div>
              <el-tooltip
                v-if="!tastingStore.decisionOf(row.batchId)!.valid"
                :content="tastingStore.decisionOf(row.batchId)!.invalidReason"
                placement="top"
                show-after="100"
              >
                <div class="invalid-reason">{{ tastingStore.decisionOf(row.batchId)!.invalidReason }}</div>
              </el-tooltip>
            </template>
            <span v-else class="muted">未品评</span>
          </template>
        </el-table-column>
        <el-table-column label="批次回写值" width="110">
          <template #default="{ row }">
            <el-tag :type="row.conclusion === '优' ? 'success' : row.conclusion === '合格' ? 'primary' : 'danger'" effect="plain">
              {{ batches.find((batch) => batch.id === row.batchId)?.conclusion || '未回写' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近出库" width="110">
          <template #default="{ row }">{{ row.lastOutAt || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button text type="primary" :icon="RefreshRight" @click="reviewBatch(row.batchId)">复核</el-button>
            <el-button text :icon="Download" @click="exportOneBatch(row.batchId)">导出批次</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>品评明细（{{ filteredRows.length }} / {{ tastings.length }}）</h3>
        <span class="muted">三维 1-10 分，结论连同依据快照保存；依据改动后该条结论自动失效</span>
      </div>

      <EmptyPanel
        v-if="ready && filteredRows.length === 0"
        title="还没有品评记录"
        description="批次出库前先过判定链核检，再录入外观 / 风味 / 质地打分，系统按均分连同依据回写批次结论。"
        action-text="新建品评"
        @action="openDialog()"
      />
      <el-table v-else :data="filteredRows" border stripe>
        <el-table-column label="批次" min-width="180">
          <template #default="{ row }">
            <div>{{ row.batchLabel }}</div>
            <span class="muted">{{ row.milkLabel }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="tasting.outAt" label="出库日期" width="110" />
        <el-table-column prop="tasting.appearance" label="外观" min-width="150" show-overflow-tooltip />
        <el-table-column prop="tasting.flavor" label="风味" min-width="150" show-overflow-tooltip />
        <el-table-column prop="tasting.texture" label="质地" min-width="150" show-overflow-tooltip />
        <el-table-column label="三维评分" width="160">
          <template #default="{ row }">
            <span class="mono">
              {{ row.tasting.appearanceScore }} / {{ row.tasting.flavorScore }} /
              {{ row.tasting.textureScore }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="评分" width="80">
          <template #default="{ row }">
            <span class="mono">{{ row.tasting.score }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结论" width="100">
          <template #default="{ row }">
            <GradeTag :conclusion="conclusionOf(row)" :score="row.tasting.score" size="small" plain />
          </template>
        </el-table-column>
        <el-table-column label="依据效力" min-width="180">
          <template #default="{ row }">
            <el-tag
              :type="row.basisStatus.valid ? 'success' : row.basisStatus.missing ? 'warning' : 'danger'"
              size="small"
              effect="plain"
            >
              {{ row.basisStatus.valid ? '依据有效' : row.basisStatus.missing ? '缺依据·待复核' : '已失效·待复核' }}
            </el-tag>
            <el-tooltip
              v-if="!row.basisStatus.valid"
              :content="row.basisStatus.invalidReason"
              placement="top"
              show-after="100"
            >
              <div class="invalid-reason">{{ row.basisStatus.invalidReason }}</div>
            </el-tooltip>
            <div v-else class="muted basis-time">
              复核于 {{ formatReviewedAt(row.tasting.basis?.reviewedAt) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="tasting.taster" label="品评人" width="90" />
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="!row.basisStatus.valid"
              text
              type="warning"
              :icon="RefreshRight"
              @click="reviewRow(row)"
            >
              复核
            </el-button>
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
        <el-descriptions-item label="结构版本">v{{ DB_VERSION }}（品评含判定链依据快照 basis）</el-descriptions-item>
        <el-descriptions-item label="最近导出">
          {{ tastingStore.lastBackupAt ? tastingStore.lastBackupAt.slice(0, 19).replace('T', ' ') : '尚未导出' }}
        </el-descriptions-item>
        <el-descriptions-item label="待品评批次">{{ pendingBatches.length }} 批</el-descriptions-item>
      </el-descriptions>

      <div class="backup-actions">
        <el-checkbox v-model="overwriteImport">导入时覆盖（勾选=先清空全部表，不勾选=重新分配 id 追加，追加的品评需重新复核）</el-checkbox>
        <el-button type="primary" :icon="Download" :loading="busy" @click="exportAll">导出全量 JSON</el-button>
        <el-button :icon="Upload" :loading="busy" @click="pickFile">导入 JSON</el-button>
        <el-button :icon="MagicStick" @click="refreshCounts">刷新统计</el-button>
        <el-button type="danger" :icon="Delete" @click="resetAll">重置并重新播种</el-button>
      </div>
      <p class="muted">
        导出文件含每条品评的判定依据快照（环境记录、转架签署、复核时间）与批次判定链摘要（核检项、失效原因）；
        导入先校验 app 字段、各集合数组与父子引用完整性，校验失败不写入任何数据。
      </p>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑品评记录（重新复核判定链）' : '新建品评记录'"
      width="680px"
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

        <div class="gate-card">
          <div class="gate-card__head">
            <span>品评前判定链核检</span>
            <el-tag :type="formGateBlocked ? 'danger' : 'success'" size="small" effect="dark">
              {{ formGate ? (formGate.ok ? '全部通过，允许品评' : '缺项挡下') : '请选择批次' }}
            </el-tag>
          </div>
          <template v-if="formGate">
            <div v-for="item in formGate.items" :key="item.key" class="gate-item">
              <el-icon :color="item.ok ? '#1e8449' : '#c0392b'" class="gate-item__icon">
                <CircleCheckFilled v-if="item.ok" />
                <WarningFilled v-else />
              </el-icon>
              <span :class="{ 'gate-item--fail': !item.ok }">{{ item.label }}：{{ item.detail }}</span>
            </div>
            <el-alert
              v-if="formGateBlocked"
              type="error"
              :closable="false"
              show-icon
              class="gate-alert"
              title="存在缺项，本次品评已挡下：请先补录 / 处置温湿度越界并签完转架作业，再重新提交。"
            />
          </template>
        </div>

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

        <el-alert :type="formGateBlocked ? 'error' : 'success'" :closable="false" show-icon>
          <template v-if="formGateBlocked">
            判定链缺项未补齐，三维均分 {{ formTotal }} 分（{{ formConclusion }}）暂不能保存。
          </template>
          <template v-else>
            三维均分 {{ formTotal }} 分 → 结论「{{ formConclusion }}」，保存时连同当前判定依据一起落档并回写批次结论。
            <span class="muted">
              （{{ SCORE_DIMENSIONS.map((item) => item.label).join(' / ') }} 各占 1/3 权重）
            </span>
          </template>
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="formGateBlocked"
          :title="formGateBlocked ? '判定链核检未通过，先补齐缺项' : ''"
          @click="submit"
        >
          {{ editingId ? '保存并重新复核' : '保存并连依据回写' }}
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

.desc-gap {
  margin-bottom: 12px;
}

.backup-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.gate-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gate-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
}

.gate-item__icon {
  margin-top: 2px;
  flex-shrink: 0;
}

.gate-item--fail {
  color: #c0392b;
  font-weight: 600;
}

.basis-time {
  font-size: 12px;
  margin-top: 2px;
}

.invalid-reason {
  font-size: 12px;
  line-height: 16px;
  color: #c0392b;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

.gate-card {
  margin: 0 0 18px 110px;
  padding: 12px 14px;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  background: #fafafa;
}

.gate-card__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  margin-bottom: 8px;
}

.gate-alert {
  margin-top: 8px;
}
</style>
