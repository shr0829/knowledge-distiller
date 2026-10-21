// lib/config.mjs — 插件条目 Config（spec §6.3 / §13）。
//
// 三条硬约束（照 dsh-chat-import 的成熟写法）：
//   1. Config 必须由插件入口导出，loader 据此把本条目登记为可配置；
//   2. 默认值必须写在 .default() 上——patch 整体替换 config、不深合并（spec §6.5）；
//   3. 字段必须 .volatile() 才可经 settings.update 编辑（宿主只把 volatile 字段投影成
//      设置表单，写非 volatile 字段会报 "is not volatile"）。
//
// schemastery 是宿主内置包：本插件不打包它，用 createRequire 从运行中的 harness bin
// （process.argv[1]）解析，失败再退回本模块锚点；都拿不到时 Config 为 undefined
//（legacy 模型），插件照常加载——绝不在模块加载期抛错。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DEFAULT_VAULT_PATH } from './paths.mjs'

function loadSchemastery() {
  const anchors = []
  const argv1 = typeof process !== 'undefined' && process.argv ? process.argv[1] : undefined
  if (typeof argv1 === 'string' && argv1 !== '') {
    try { anchors.push(pathToFileURL(argv1).href) } catch { /* 非法 argv[1]：跳过 */ }
  }
  anchors.push(import.meta.url)
  for (const anchor of anchors) {
    try {
      const mod = createRequire(anchor)('@deepseek-ai/schemastery')
      if (mod) return mod.default || mod
    } catch { /* 该锚点解析不到：试下一个 */ }
  }
  return undefined
}

const Schema = loadSchemastery()

// .volatile() 只存在于条目模型宿主自带的 schemastery；没有它时构造会在加载期抛
// "volatile is not a function"，所以先探测。
function supportsVolatile(S) {
  if (!S) return false
  try { return typeof S.boolean().volatile === 'function' } catch { return false }
}

/** spec §13 的默认值（唯一真相；config 缺席时也用它）。 */
export const DEFAULTS = Object.freeze({
  vaultPath: DEFAULT_VAULT_PATH,
  captureEnabled: true,
  captureMaxToolBytes: 4096,
  captureBlocklist: '',
  pipelineBatchSize: 12,
  pipelineIdleMinutes: 30,
  pipelineAutoRun: true,
  pipelineModel: '',
  retrievalMaxResults: 8,
  retrievalWeightText: 0.6,
  retrievalWeightRecency: 0.25,
  retrievalWeightCentrality: 0.15,
  writeLanguage: 'zh',
})

export const Config = supportsVolatile(Schema)
  ? Schema.object({
      vaultPath: Schema.string().default(DEFAULTS.vaultPath).volatile(),
      captureEnabled: Schema.boolean().default(DEFAULTS.captureEnabled).volatile(),
      captureMaxToolBytes: Schema.number().default(DEFAULTS.captureMaxToolBytes).volatile(),
      captureBlocklist: Schema.string().default(DEFAULTS.captureBlocklist).volatile(),
      pipelineBatchSize: Schema.number().default(DEFAULTS.pipelineBatchSize).volatile(),
      pipelineIdleMinutes: Schema.number().default(DEFAULTS.pipelineIdleMinutes).volatile(),
      pipelineAutoRun: Schema.boolean().default(DEFAULTS.pipelineAutoRun).volatile(),
      pipelineModel: Schema.string().default(DEFAULTS.pipelineModel).volatile(),
      retrievalMaxResults: Schema.number().default(DEFAULTS.retrievalMaxResults).volatile(),
      retrievalWeightText: Schema.number().default(DEFAULTS.retrievalWeightText).volatile(),
      retrievalWeightRecency: Schema.number().default(DEFAULTS.retrievalWeightRecency).volatile(),
      retrievalWeightCentrality: Schema.number().default(DEFAULTS.retrievalWeightCentrality).volatile(),
      writeLanguage: Schema.string().default(DEFAULTS.writeLanguage).volatile(),
    })
  : undefined

/**
 * 把宿主传入的 config（可能是带 .get() 的实时引用）归一成普通对象。
 * 条目模型下 volatile 字段是 live 引用：宿主在设置写入时原地更新，读一次拿到当前值。
 */
export function readConfig(config) {
  const out = { ...DEFAULTS }
  if (!config || typeof config !== 'object') return out
  for (const key of Object.keys(DEFAULTS)) {
    let value
    try {
      const probe = config[key]
      value = probe && typeof probe.get === 'function' ? probe.get() : probe
    } catch { value = undefined }
    if (value !== undefined && value !== null) out[key] = value
  }
  // 数值兜底：设置表单可能写进字符串或越界数值。
  out.captureMaxToolBytes = clampInt(out.captureMaxToolBytes, 256, 65536, DEFAULTS.captureMaxToolBytes)
  out.pipelineBatchSize = clampInt(out.pipelineBatchSize, 3, 64, DEFAULTS.pipelineBatchSize)
  out.pipelineIdleMinutes = clampInt(out.pipelineIdleMinutes, 1, 1440, DEFAULTS.pipelineIdleMinutes)
  out.retrievalMaxResults = clampInt(out.retrievalMaxResults, 1, 20, DEFAULTS.retrievalMaxResults)
  out.vaultPath = String(out.vaultPath || DEFAULTS.vaultPath)
  out.captureBlocklist = String(out.captureBlocklist || '')
  out.pipelineModel = String(out.pipelineModel || '')
  out.captureEnabled = out.captureEnabled !== false
  out.pipelineAutoRun = out.pipelineAutoRun !== false
  return out
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
