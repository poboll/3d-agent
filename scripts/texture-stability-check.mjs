import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import '../server/env-loader.mjs'

const API_BASE = (process.env.TEXTURE_STABILITY_API_BASE || process.env.SMOKE_API_BASE || `http://${process.env.API_HOST || '127.0.0.1'}:${process.env.API_PORT || 8791}`).replace(/\/+$/, '')
const JOBS_FILE = process.env.TEXTURE_STABILITY_JOBS_FILE || '.workflow-store/jobs.json'
const REPORT_DIR = process.env.TEXTURE_STABILITY_REPORT_DIR || '.workflow-store'
const DEFAULT_RUNS = Number(process.env.TEXTURE_STABILITY_RUNS || 3)
const DEFAULT_TIMEOUT_MINUTES = Number(process.env.TEXTURE_STABILITY_TIMEOUT_MINUTES || 75)
const DEFAULT_POLL_MS = Number(process.env.TEXTURE_STABILITY_POLL_MS || 8000)
const DEFAULT_COOLDOWN_MS = Number(process.env.TEXTURE_STABILITY_COOLDOWN_MS || 15000)
const DEFAULT_DRAIN_TIMEOUT_MS = Number(process.env.TEXTURE_STABILITY_DRAIN_TIMEOUT_MS || 120000)
const DEFAULT_MIN_RAM_RECOVERY_GIB = Number(process.env.TEXTURE_STABILITY_MIN_RAM_RECOVERY_GIB || 16.5)
const DEFAULT_TEXTURE_MODE = normalizeTextureStabilityMode(process.env.TEXTURE_STABILITY_TEXTURE_MODE || 'fallback-color')
const LOG_INTERVAL_MS = Number(process.env.TEXTURE_STABILITY_LOG_INTERVAL_MS || 30000)

const args = parseArgs(process.argv.slice(2))

async function main() {
  const report = await runTextureStabilityCheck(normalizeTextureStabilityOptions({
    runs: args.runs,
    timeoutMinutes: args['timeout-minutes'],
    pollMs: args['poll-ms'],
    cooldownMs: args['cooldown-ms'],
    drainTimeoutMs: args['drain-timeout-ms'],
    minRamRecoveryGiB: args['min-ram-recovery-gib'],
    textureMode: args['texture-mode'],
    sourceJobId: args['source-job'],
    apiBase: args.api,
    dryRun: args['dry-run'],
  }))
  console.log(JSON.stringify(report.summary, null, 2))

  if (!report.summary?.ok) {
    process.exitCode = report.errorCode === 'TEXTURE_RESOURCE_GUARD' ? 2 : 1
  }
}

export async function runTextureStabilityCheck(input = {}) {
  const options = normalizeTextureStabilityOptions(input)
  const report = createReport(options)
  try {
    const jobs = await readStoredJobs(JOBS_FILE)
    const sourceJob = selectTextureSourceJob(jobs, options.sourceJobId)
    report.sourceJob = summarizeSourceJob(sourceJob)
    console.log(`[texture-stability] source=${sourceJob.id} raw=${sourceJob.rawModelUrl || sourceJob.result?.rawModelUrl || 'unknown'}`)

    if (options.dryRun) {
      const run = await runTextureDryRunCycle(sourceJob, options)
      report.runs.push(run)
      report.finishedAt = new Date().toISOString()
      report.summary = summarizeStabilityReport(report)
      await writeStabilityReport(report, REPORT_DIR)
      return report
    }

    for (let index = 0; index < options.runs; index += 1) {
      const run = await runTextureEnhancementCycle(sourceJob, index + 1, options)
      report.runs.push(run)
      if (run.status !== 'completed') break
      if (index < options.runs - 1 && options.cooldownMs > 0) {
        console.log(`[texture-stability] cooldown ${Math.round(options.cooldownMs / 1000)}s before next run`)
        await delay(options.cooldownMs)
      }
      if (index < options.runs - 1) {
        const drain = await waitForSafeNextRun(options.apiBase, options)
        run.drainBeforeNext = drain
      }
    }

    report.finishedAt = new Date().toISOString()
    report.summary = summarizeStabilityReport(report)
    await writeStabilityReport(report, REPORT_DIR)
    return report
  } catch (error) {
    if (error.run && !report.runs.some((run) => run.runNumber === error.run.runNumber)) {
      report.runs.push(error.run)
    }
    report.finishedAt = new Date().toISOString()
    report.error = error.message || String(error)
    report.errorCode = error.code || 'TEXTURE_STABILITY_ERROR'
    report.summary = summarizeStabilityReport(report)
    await writeStabilityReport(report, REPORT_DIR).catch(() => {})
    console.error(`[texture-stability] ${report.error}`)
    return report
  }
}

export async function readLatestStabilityReport(reportDir = REPORT_DIR) {
  try {
    const raw = await readFile(path.join(reportDir, 'texture-stability-latest.json'), 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function readLatestConsecutiveStabilityReport(reportDir = REPORT_DIR) {
  try {
    const raw = await readFile(path.join(reportDir, 'texture-stability-latest-consecutive.json'), 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  try {
    const entries = await readdir(reportDir)
    const candidates = entries
      .filter((entry) => /^texture-stability-.*\.json$/.test(entry))
      .filter((entry) => entry !== 'texture-stability-latest.json')
      .filter((entry) => entry !== 'texture-stability-latest-consecutive.json')
      .sort()
      .reverse()

    for (const entry of candidates) {
      const raw = await readFile(path.join(reportDir, entry), 'utf8')
      const report = JSON.parse(raw)
      if (isConsecutiveStabilityReport(report)) return report
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  return null
}

async function runTextureDryRunCycle(sourceJob, options) {
  const run = {
    runNumber: 0,
    sourceJobId: sourceJob.id,
    startedAt: new Date().toISOString(),
    status: 'completed',
    dryRun: true,
    checks: [],
  }

  const before = await checkedProviderStatus(options.apiBase, 'dry-run-before')
  run.resourceBefore = summarizeProviderStatus(before.status)
  run.checks.push(before.check)
  run.resourceGate = evaluateTextureGate(before.status, { textureMode: options.textureMode })
  run.completedJob = {
    id: sourceJob.id,
    status: sourceJob.status,
    workflowMode: 'texture-stability-dry-run',
    provider: sourceJob.provider,
    progress: sourceJob.progress,
    stage: '只读预检完成：未提交贴图增强任务。',
    textureMode: options.textureMode,
    requestedTextureMode: options.textureMode,
    effectiveTextureMode: 'dry-run',
    rawModelUrl: sourceJob.rawModelUrl || sourceJob.result?.rawModelUrl,
    modelUrl: sourceJob.result?.modelUrl || sourceJob.rawModelUrl || sourceJob.result?.rawModelUrl,
    fileSize: sourceJob.result?.fileSize,
  }
  run.usableColoredModel = {
    ok: true,
    reason: 'dry-run-ready',
    message: run.resourceGate.ok
      ? '只读预检通过：来源 raw GLB、参考图和资源读数可用，尚未提交贴图任务。'
      : `只读预检已完成但暂不建议提交贴图任务：${run.resourceGate.message}`,
  }
  run.finishedAt = new Date().toISOString()
  console.log(`[texture-stability] dry-run ${sourceJob.id}; gate=${run.resourceGate.reason}; freeRAM=${run.resourceBefore.ramFreeGiB ?? 'n/a'}GiB freeVRAM=${run.resourceBefore.vramFreeGiB ?? 'n/a'}GiB`)
  return run
}

async function waitForSafeNextRun(apiBase, options) {
  const deadline = Date.now() + options.drainTimeoutMs
  let last = null
  while (Date.now() < deadline) {
    const status = await api('/api/providers/status?check=1', { apiBase })
    const summary = summarizeProviderStatus(status)
    last = {
      checkedAt: new Date().toISOString(),
      queueRunning: summary.queueRunning,
      queuePending: summary.queuePending,
      localRunning: summary.localRunning,
      localPending: summary.localPending,
      ramFreeGiB: summary.ramFreeGiB,
      vramFreeGiB: summary.vramFreeGiB,
    }
    const queueIdle = summary.queueRunning === 0 && summary.queuePending === 0 && summary.localRunning === 0 && summary.localPending === 0
    const fallbackOnly = options.textureMode === 'fallback-color'
    const ramReady = fallbackOnly || !Number.isFinite(options.minRamRecoveryGiB) || !Number.isFinite(summary.ramFreeGiB) || summary.ramFreeGiB >= options.minRamRecoveryGiB
    if (queueIdle && ramReady) return { ok: true, ...last }
    console.log(`[texture-stability] waiting for drain: remote=${summary.queueRunning}/${summary.queuePending} local=${summary.localRunning}/${summary.localPending} ram=${summary.ramFreeGiB ?? 'n/a'}GiB`)
    await delay(Math.min(10000, Math.max(2000, options.cooldownMs || 5000)))
  }
  return {
    ok: false,
    ...last,
    message: `等待远端队列清空或 RAM 恢复超时：要求 RAM >= ${options.minRamRecoveryGiB}GiB。`,
  }
}

async function runTextureEnhancementCycle(sourceJob, runNumber, options) {
  const run = {
    runNumber,
    sourceJobId: sourceJob.id,
    startedAt: new Date().toISOString(),
    status: 'started',
    checks: [],
  }

  try {
    const before = await checkedProviderStatus(options.apiBase, `run-${runNumber}-before`)
    run.resourceBefore = summarizeProviderStatus(before.status)
    run.checks.push(before.check)
    const guard = evaluateTextureGate(before.status, { textureMode: options.textureMode })
    run.resourceGate = guard
    if (!guard.ok) {
      run.status = 'resource-guarded'
      run.finishedAt = new Date().toISOString()
      run.error = guard.message
      throw Object.assign(new Error(guard.message), {
        code: 'TEXTURE_RESOURCE_GUARD',
        run,
      })
    }

    console.log(`[texture-stability] run ${runNumber}: submitting ${options.textureMode} texture enhance; freeRAM=${run.resourceBefore.ramFreeGiB ?? 'n/a'}GiB freeVRAM=${run.resourceBefore.vramFreeGiB ?? 'n/a'}GiB`)
    const created = await api(`/api/jobs/${encodeURIComponent(sourceJob.id)}/texture-enhance`, {
      method: 'POST',
      body: { textureMode: options.textureMode, forceFallback: options.textureMode === 'fallback-color' },
      apiBase: options.apiBase,
    })
    run.jobId = created.job?.id
    if (!run.jobId) throw new Error('贴图增强接口没有返回 job.id。')

    const completed = await pollTextureJob(run.jobId, options, runNumber)
    run.completedJob = summarizeCompletedJob(completed)
    run.status = completed.status

    if (completed.status !== 'completed') {
      run.error = completed.error || completed.stage || `贴图任务状态异常：${completed.status}`
      run.finishedAt = new Date().toISOString()
      return run
    }

    const modelUrl = completed.result?.modelUrl
    if (!modelUrl) throw new Error(`贴图任务 ${run.jobId} 已完成但缺少 modelUrl。`)
    const model = await inspectRemoteGlb(modelUrl, options.apiBase)
    run.model = model
    const textureMode = completed.result?.effectiveTextureMode || completed.effectiveTextureMode || completed.result?.textureMode || completed.textureMode
    run.usableColoredModel = isUsableColoredModel(model, textureMode)
    if (!run.usableColoredModel.ok) {
      throw new Error(`贴图任务 ${run.jobId} 产物仍像白模：${run.usableColoredModel.message}`)
    }

    const after = await checkedProviderStatus(options.apiBase, `run-${runNumber}-after`)
    run.resourceAfter = summarizeProviderStatus(after.status)
    run.checks.push(after.check)
    run.finishedAt = new Date().toISOString()
    console.log(`[texture-stability] run ${runNumber}: completed ${run.jobId}; mode=${textureMode}; textures=${model.textures}; materials=${model.materials}; file=${model.bytes}B`)
    return run
  } catch (error) {
    run.finishedAt = run.finishedAt || new Date().toISOString()
    run.status = run.status === 'resource-guarded' ? run.status : 'failed'
    run.error = error.message || String(error)
    throw Object.assign(error, { run })
  }
}

async function checkedProviderStatus(apiBase, label) {
  const status = await api('/api/providers/status?check=1', { apiBase })
  const summary = summarizeProviderStatus(status)
  return {
    status,
    check: {
      label,
      ok: Boolean(summary.ready),
      ready: summary.ready,
      queueRunning: summary.queueRunning,
      queuePending: summary.queuePending,
      localRunning: summary.localRunning,
      localPending: summary.localPending,
      ramFreeGiB: summary.ramFreeGiB,
      vramFreeGiB: summary.vramFreeGiB,
    },
  }
}

async function pollTextureJob(jobId, options, runNumber) {
  const deadline = Date.now() + options.timeoutMinutes * 60 * 1000
  let lastStage = ''
  let lastLogAt = 0
  while (Date.now() < deadline) {
    const payload = await api(`/api/jobs/${encodeURIComponent(jobId)}`, { apiBase: options.apiBase })
    const job = payload.job
    if (!job) throw new Error(`贴图任务 ${jobId} 查询没有返回 job。`)
    if (job.status === 'completed' || job.status === 'failed') return job
    const stage = `${job.progress || 0}% ${job.stage || job.status || 'processing'}`
    const shouldLog = stage !== lastStage || Date.now() - lastLogAt >= LOG_INTERVAL_MS
    if (shouldLog) {
      console.log(`[texture-stability] run ${runNumber}: ${jobId} ${stage}`)
      lastStage = stage
      lastLogAt = Date.now()
    }
    await delay(options.pollMs)
  }
  throw new Error(`贴图任务超时：${jobId}，已等待 ${options.timeoutMinutes} 分钟。`)
}

async function inspectRemoteGlb(modelUrl, apiBase) {
  const response = await fetch(toUrl(modelUrl, apiBase))
  if (!response.ok) throw new Error(`GLB 下载失败：${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const info = inspectGlbBuffer(buffer)
  return {
    url: modelUrl,
    bytes: buffer.byteLength,
    ...info,
  }
}

export function inspectGlbBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) throw new Error('GLB 文件过小。')
  if (buffer.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error('GLB 文件头不是 glTF。')
  const totalLength = buffer.readUInt32LE(8)
  let offset = 12
  let json = null
  while (offset + 8 <= Math.min(totalLength, buffer.length)) {
    const chunkLength = buffer.readUInt32LE(offset)
    const chunkType = buffer.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkLength
    if (chunkEnd > buffer.length) throw new Error('GLB chunk 长度无效。')
    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(buffer.subarray(chunkStart, chunkEnd).toString('utf8').replace(/[\u0000\s]+$/g, ''))
      break
    }
    offset = chunkEnd
  }
  if (!json) throw new Error('GLB 缺少 JSON chunk。')
  const materials = Array.isArray(json.materials) ? json.materials : []
  const usedMaterialIndexes = getUsedMaterialIndexes(json)
  const usedMaterials = usedMaterialIndexes.length
    ? usedMaterialIndexes.map((index) => materials[index]).filter(Boolean)
    : materials
  const materialColors = materials
    .map((material) => material?.pbrMetallicRoughness?.baseColorFactor)
    .filter((color) => Array.isArray(color))
  const usedMaterialColors = usedMaterials
    .map((material) => material?.pbrMetallicRoughness?.baseColorFactor)
    .filter((color) => Array.isArray(color))
  const nonWhiteMaterials = materialColors.filter((color) => !isNearWhiteColor(color)).length
  const usedNonWhiteMaterials = usedMaterialColors.filter((color) => !isNearWhiteColor(color)).length
  const texturedUsedMaterials = usedMaterials
    .filter((material) => Number.isInteger(material?.pbrMetallicRoughness?.baseColorTexture?.index))
    .length
  return {
    generator: json.asset?.generator || '',
    materials: materials.length,
    textures: Array.isArray(json.textures) ? json.textures.length : 0,
    images: Array.isArray(json.images) ? json.images.length : 0,
    meshes: Array.isArray(json.meshes) ? json.meshes.length : 0,
    usedMaterials: usedMaterialIndexes.length,
    usedMaterialIndexes,
    materialColors,
    usedMaterialColors,
    nonWhiteMaterials,
    usedNonWhiteMaterials,
    texturedUsedMaterials,
  }
}

export function isUsableColoredModel(model, textureMode = '') {
  if (!model?.bytes) return { ok: false, message: '模型文件为空。' }
  if (model.textures > 0 && model.images > 0 && (model.texturedUsedMaterials > 0 || !model.usedMaterials)) {
    return { ok: true, reason: 'embedded-texture-on-active-material' }
  }
  if (model.usedNonWhiteMaterials > 0) return { ok: true, reason: 'active-non-white-material' }
  if (model.nonWhiteMaterials > 0 && !model.usedMaterials) return { ok: true, reason: 'non-white-material' }
  return {
    ok: false,
    message: `mode=${textureMode || 'unknown'}, materials=${model.materials || 0}, usedMaterials=${model.usedMaterials || 0}, textures=${model.textures || 0}, images=${model.images || 0}, activeTextured=${model.texturedUsedMaterials || 0}, activeNonWhite=${model.usedNonWhiteMaterials || 0}, nonWhite=${model.nonWhiteMaterials || 0}`,
  }
}

function getUsedMaterialIndexes(json) {
  const indexes = new Set()
  const meshes = Array.isArray(json.meshes) ? json.meshes : []
  for (const mesh of meshes) {
    const primitives = Array.isArray(mesh.primitives) ? mesh.primitives : []
    for (const primitive of primitives) {
      if (Number.isInteger(primitive?.material)) indexes.add(primitive.material)
    }
  }
  return [...indexes].sort((left, right) => left - right)
}

export function evaluateTextureGate(status, options = {}) {
  const summary = summarizeProviderStatus(status)
  const fallbackOnly = options.textureMode === 'fallback-color' || options.fallbackOnly
  if (fallbackOnly) {
    if (summary.localRunning > 0 || summary.localPending > 0) {
      return {
        ok: false,
        reason: 'local-queue-busy',
        message: `本地保护队列繁忙：${summary.localRunning} 个运行 / ${summary.localPending} 个等待。`,
      }
    }
    return {
      ok: true,
      reason: 'fallback-ready',
      message: '轻量原参考图贴图验证不会提交远端 Hunyuan3D-Paint 重任务，仅串行复用 raw GLB。',
    }
  }
  if (!summary.ready) {
    return { ok: false, reason: 'provider-not-ready', message: summary.message || '自部署 3D 服务未就绪。' }
  }
  if (summary.localRunning > 0 || summary.localPending > 0) {
    return {
      ok: false,
      reason: 'local-queue-busy',
      message: `本地保护队列繁忙：${summary.localRunning} 个运行 / ${summary.localPending} 个等待。`,
    }
  }
  if (summary.queueRunning > 0 || summary.queuePending > 0) {
    return {
      ok: false,
      reason: 'remote-queue-busy',
      message: `远端 ComfyUI 队列繁忙：${summary.queueRunning} 个运行 / ${summary.queuePending} 个等待。`,
    }
  }
  if (Number.isFinite(summary.ramRequiredGiB) && Number.isFinite(summary.ramFreeGiB) && summary.ramFreeGiB < summary.ramRequiredGiB) {
    return {
      ok: false,
      reason: 'ram-low',
      message: `可用内存 ${summary.ramFreeGiB}GiB 低于贴图提交线 ${summary.ramRequiredGiB}GiB。`,
    }
  }
  if (Number.isFinite(summary.vramRequiredGiB) && Number.isFinite(summary.vramFreeGiB) && summary.vramFreeGiB < summary.vramRequiredGiB) {
    return {
      ok: false,
      reason: 'vram-low',
      message: `可用显存 ${summary.vramFreeGiB}GiB 低于贴图提交线 ${summary.vramRequiredGiB}GiB。`,
    }
  }
  return {
    ok: true,
    reason: 'ready',
    message: `资源闸门通过：RAM ${summary.ramFreeGiB ?? 'n/a'}GiB / VRAM ${summary.vramFreeGiB ?? 'n/a'}GiB。`,
  }
}

export function summarizeProviderStatus(status) {
  const node = status?.model3d?.selfhostTriposg || {}
  const remote = node.status || {}
  const texture = node.texture || remote.texture || {}
  const queue = remote.queue || {}
  const runtime = node.runtime || {}
  const gpu = Array.isArray(remote.gpu) ? remote.gpu[0] : null
  const ramFreeGiB = bytesToGiB(remote.ram?.free ?? remote.ram?.available)
  const ramTotalGiB = bytesToGiB(remote.ram?.total)
  const vramFreeGiB = bytesToGiB(gpu?.vramFree)
  const vramTotalGiB = bytesToGiB(gpu?.vramTotal)
  return {
    ready: Boolean(remote.ok && remote.state === 'ready'),
    message: remote.message,
    baseUrl: node.baseUrl || remote.baseUrl,
    lowMemoryRemoteEnabled: texture.lowMemoryRemoteEnabled,
    queueRunning: Number(queue.running || 0),
    queuePending: Number(queue.pending || 0),
    localRunning: Number(runtime.running || 0),
    localPending: Number(runtime.pending || 0),
    ramFreeGiB,
    ramTotalGiB,
    vramFreeGiB,
    vramTotalGiB,
    ramRequiredGiB: Number(texture.minRamFreeGb),
    vramRequiredGiB: Number(texture.minVramFreeGb),
    runtimeMinRamFreeGb: Number(texture.runtimeMinRamFreeGb),
    runtimeMinVramFreeGb: Number(texture.runtimeMinVramFreeGb),
    steps: Number(texture.steps),
    faces: Number(texture.faces),
  }
}

export function selectTextureSourceJob(jobs, requestedId = '') {
  if (!Array.isArray(jobs) || !jobs.length) {
    throw new Error('没有找到历史生成任务，无法复用 raw GLB 做贴图稳定性测试。')
  }
  if (requestedId) {
    const job = jobs.find((item) => item.id === requestedId)
    if (!job) throw new Error(`找不到指定来源任务：${requestedId}`)
    assertTextureSourceJob(job)
    return job
  }
  const candidates = jobs
    .filter((job) => {
      if (job.provider !== 'selfhost-triposg') return false
      if (job.status !== 'completed') return false
      if (job.workflowMode === 'texture-enhance') return false
      if (!String(job.referenceId || job.reference?.id || '').trim()) return false
      if (!String(job.rawMeshServerPath || job.result?.rawMeshServerPath || '').trim()) return false
      if (!String(job.rawModelUrl || job.result?.rawModelUrl || job.result?.modelUrl || '').trim()) return false
      return true
    })
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
  if (!candidates.length) {
    throw new Error('没有找到已完成且带 rawMeshServerPath 的自部署图生 3D 来源任务。')
  }
  return candidates[0]
}

function assertTextureSourceJob(job) {
  if (job.provider !== 'selfhost-triposg') throw new Error(`来源任务 ${job.id} 不是自部署 TripoSG。`)
  if (job.status !== 'completed') throw new Error(`来源任务 ${job.id} 尚未完成。`)
  if (!String(job.referenceId || job.reference?.id || '').trim()) throw new Error(`来源任务 ${job.id} 缺少参考图。`)
  if (!String(job.rawModelUrl || job.result?.rawModelUrl || job.result?.modelUrl || '').trim()) throw new Error(`来源任务 ${job.id} 缺少 raw GLB URL。`)
}

async function readStoredJobs(filePath) {
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed.jobs) ? parsed.jobs : []
}

async function api(apiPath, { method = 'GET', body, apiBase = API_BASE } = {}) {
  const response = await fetch(toUrl(apiPath, apiBase), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(async () => ({ error: await response.text() }))
  if (!response.ok || payload.error) {
    throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status, payload })
  }
  return payload
}

function toUrl(apiPath, apiBase) {
  if (/^https?:\/\//i.test(apiPath)) return apiPath
  return `${apiBase.replace(/\/+$/, '')}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`
}

function summarizeCompletedJob(job) {
  return {
    id: job.id,
    status: job.status,
    workflowMode: job.workflowMode,
    provider: job.provider,
    progress: job.progress,
    stage: job.stage,
    textureMode: job.textureMode,
    requestedTextureMode: job.requestedTextureMode,
    effectiveTextureMode: job.effectiveTextureMode || job.result?.effectiveTextureMode,
    forceTextureFallback: job.forceTextureFallback,
    textureFallbackReason: job.textureFallbackReason || job.result?.textureFallbackReason,
    providerJobId: job.providerJobId,
    sourceProviderJobId: job.sourceProviderJobId,
    rawModelUrl: job.rawModelUrl || job.result?.rawModelUrl,
    texturedModelUrl: job.result?.texturedModelUrl,
    modelUrl: job.result?.modelUrl,
    fileSize: job.result?.fileSize,
  }
}

function summarizeSourceJob(job) {
  return {
    id: job.id,
    workflowMode: job.workflowMode,
    template: job.template,
    referenceId: job.referenceId || job.reference?.id,
    rawModelUrl: job.rawModelUrl || job.result?.rawModelUrl,
    rawMeshServerPath: job.rawMeshServerPath || job.result?.rawMeshServerPath,
    modelUrl: job.result?.modelUrl,
    updatedAt: job.updatedAt,
  }
}

export function summarizeStabilityReport(report) {
  if (report.options?.dryRun) {
    const run = report.runs[0]
    const gate = run?.resourceGate
    const ok = Boolean(run && run.status === 'completed' && gate?.ok)
    return {
      ok,
      dryRun: true,
      requestedRuns: 0,
      completedRuns: run ? 1 : 0,
      coloredRuns: 0,
      hunyuanRuns: 0,
      fallbackColorRuns: 0,
      failedRuns: ok ? 0 : run ? 1 : 0,
      textureMode: report.options.textureMode,
      sourceJobId: report.sourceJob?.id,
      lastJobId: report.sourceJob?.id,
      lastModelUrl: report.sourceJob?.modelUrl || report.sourceJob?.rawModelUrl,
      resourceGate: gate?.reason,
      resourceMessage: gate?.message,
      reportPath: report.reportPath,
    }
  }
  const completedRuns = report.runs.filter((run) => run.status === 'completed')
  const coloredRuns = completedRuns.filter((run) => run.usableColoredModel?.ok)
  const hunyuanRuns = completedRuns.filter((run) => run.completedJob?.effectiveTextureMode === 'hunyuan')
  const fallbackRuns = completedRuns.filter((run) => run.completedJob?.effectiveTextureMode === 'fallback-color')
  const failedRuns = report.runs.filter((run) => run.status !== 'completed')
  const ok = !report.error && report.runs.length === report.options.runs && failedRuns.length === 0 && coloredRuns.length === completedRuns.length
  return {
    ok,
    requestedRuns: report.options.runs,
    completedRuns: completedRuns.length,
    coloredRuns: coloredRuns.length,
    hunyuanRuns: hunyuanRuns.length,
    fallbackColorRuns: fallbackRuns.length,
    ...(report.options.textureMode ? { textureMode: report.options.textureMode } : {}),
    failedRuns: failedRuns.length,
    sourceJobId: report.sourceJob?.id,
    lastJobId: completedRuns.at(-1)?.jobId,
    lastModelUrl: completedRuns.at(-1)?.completedJob?.modelUrl,
    reportPath: report.reportPath,
  }
}

async function writeStabilityReport(report, dir) {
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `texture-stability-${stamp}.json`
  const reportPath = path.join(dir, fileName)
  report.reportPath = reportPath
  report.summary = summarizeStabilityReport(report)
  const tmpPath = path.join(dir, `${fileName}.tmp`)
  await writeFile(tmpPath, `${JSON.stringify(report, null, 2)}\n`)
  await rename(tmpPath, reportPath)
  const latestTmp = path.join(dir, 'texture-stability-latest.json.tmp')
  await writeFile(latestTmp, `${JSON.stringify(report, null, 2)}\n`)
  await rename(latestTmp, path.join(dir, 'texture-stability-latest.json'))
  if (isConsecutiveStabilityReport(report)) {
    const consecutiveTmp = path.join(dir, 'texture-stability-latest-consecutive.json.tmp')
    await writeFile(consecutiveTmp, `${JSON.stringify(report, null, 2)}\n`)
    await rename(consecutiveTmp, path.join(dir, 'texture-stability-latest-consecutive.json'))
  }
  const info = await stat(reportPath)
  console.log(`[texture-stability] report=${reportPath} bytes=${info.size}`)
}

function isConsecutiveStabilityReport(report) {
  const summary = report?.summary || summarizeStabilityReport(report)
  return Boolean(summary && !summary.dryRun && Number(summary.requestedRuns || 0) > 0)
}

function createReport(options) {
  return {
    createdAt: new Date().toISOString(),
    options,
    sourceJob: null,
    runs: [],
    summary: null,
  }
}

function parseArgs(argv) {
  const parsed = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const [key, ...rest] = arg.slice(2).split('=')
    parsed[key] = rest.length ? rest.join('=') : true
  }
  return parsed
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

export function normalizeTextureStabilityOptions(input = {}) {
  return {
    runs: positiveNumber(input.runs, DEFAULT_RUNS),
    timeoutMinutes: positiveNumber(input.timeoutMinutes ?? input['timeout-minutes'], DEFAULT_TIMEOUT_MINUTES),
    pollMs: positiveNumber(input.pollMs ?? input['poll-ms'], DEFAULT_POLL_MS),
    cooldownMs: positiveNumber(input.cooldownMs ?? input['cooldown-ms'], DEFAULT_COOLDOWN_MS),
    drainTimeoutMs: positiveNumber(input.drainTimeoutMs ?? input['drain-timeout-ms'], DEFAULT_DRAIN_TIMEOUT_MS),
    minRamRecoveryGiB: positiveNumber(input.minRamRecoveryGiB ?? input['min-ram-recovery-gib'], DEFAULT_MIN_RAM_RECOVERY_GIB),
    textureMode: normalizeTextureStabilityMode(input.textureMode ?? input['texture-mode'] ?? DEFAULT_TEXTURE_MODE),
    sourceJobId: String(input.sourceJobId ?? input['source-job'] ?? process.env.TEXTURE_STABILITY_SOURCE_JOB ?? ''),
    apiBase: String(input.apiBase ?? input.api ?? API_BASE).replace(/\/+$/, ''),
    dryRun: parseBoolean(input.dryRun ?? input['dry-run'] ?? process.env.TEXTURE_STABILITY_DRY_RUN),
  }
}

export function normalizeTextureStabilityMode(value) {
  const mode = String(value || '').trim()
  if (mode === 'hunyuan') return 'hunyuan'
  return 'fallback-color'
}

function parseBoolean(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes'
}

function bytesToGiB(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return Number((number / 1024 / 1024 / 1024).toFixed(2))
}

function isNearWhiteColor(color) {
  const rgb = color.slice(0, 3).map(Number)
  return rgb.length === 3 && rgb.every((value) => Number.isFinite(value) && value >= 0.92)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message || error)
    process.exitCode = process.exitCode || 1
  })
}
