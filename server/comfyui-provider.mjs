import { readFile, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  COMFYUI_BASE_URL,
  COMFYUI_FACES,
  COMFYUI_GUIDANCE_SCALE,
  COMFYUI_OUTPUT_PREFIX,
  COMFYUI_POLL_INTERVAL_MS,
  COMFYUI_STEPS,
  COMFYUI_TIMEOUT_MS,
  COMFYUI_WORKFLOW_TEMPLATE,
  LOCAL_MODEL_DIR,
  WORKFLOW_STORE_DIR,
} from './config.mjs'
import { getReferenceImage } from './reference-store.mjs'
import { sanitizeFileName } from './http-utils.mjs'
import { sanitizeModelId, validateModelBuffer } from './model-store.mjs'
import { getTemplateDisplayName } from './workflow-utils.mjs'

const COMFYUI_HISTORY_RETRY_LIMIT = 8
const COMFYUI_DOWNLOAD_RETRY_LIMIT = 3

export async function getComfyUiStatus() {
  try {
    const stats = await fetchJson(`${COMFYUI_BASE_URL}/system_stats`, { timeoutMs: 12000 })
    const queue = await fetchJson(`${COMFYUI_BASE_URL}/queue`, { timeoutMs: 12000 }).catch(() => null)
    return {
      ok: true,
      baseUrl: COMFYUI_BASE_URL,
      workflowTemplate: COMFYUI_WORKFLOW_TEMPLATE,
      gpu: stats?.devices?.map((device) => ({
        name: device.name,
        type: device.type,
        vramTotal: device.vram_total,
        vramFree: device.vram_free,
      })) || [],
      queue: queue
        ? {
            running: Array.isArray(queue.queue_running) ? queue.queue_running.length : 0,
            pending: Array.isArray(queue.queue_pending) ? queue.queue_pending.length : 0,
          }
        : null,
    }
  } catch (error) {
    return {
      ok: false,
      baseUrl: COMFYUI_BASE_URL,
      workflowTemplate: COMFYUI_WORKFLOW_TEMPLATE,
      error: error.message || 'ComfyUI 健康检查失败。',
    }
  }
}

export async function diagnoseComfyUiJob(job) {
  if (!job?.providerJobId) {
    throw Object.assign(new Error('缺少 ComfyUI prompt_id，无法诊断远端三维任务。'), { status: 400 })
  }

  const [queue, historyPayload] = await Promise.all([
    fetchJson(`${COMFYUI_BASE_URL}/queue`, {
      timeoutMs: 15000,
      context: '查询 ComfyUI 队列',
    }).catch((error) => ({
      error: error.message || '队列查询失败。',
    })),
    fetchJson(`${COMFYUI_BASE_URL}/history/${encodeURIComponent(job.providerJobId)}`, {
      timeoutMs: 30000,
      context: '查询 ComfyUI 任务历史',
    }).catch((error) => ({
      error: error.message || '历史查询失败。',
    })),
  ])

  const historyItem = historyPayload?.[job.providerJobId] || (historyPayload && !historyPayload.error ? Object.values(historyPayload)[0] : null)
  const outputs = historyItem ? findGlbOutputs(historyItem) : []
  const queueSummary = summarizeComfyQueue(queue, job.providerJobId)
  const historyStatus = summarizeHistoryStatus(historyItem, historyPayload?.error)
  if (historyItem) await saveHistory(job.id, job.providerJobId, historyItem)

  return {
    promptId: job.providerJobId,
    shortPromptId: shortPromptId(job.providerJobId),
    baseUrl: COMFYUI_BASE_URL,
    queue: queueSummary,
    history: historyStatus,
    outputs: {
      glbCount: outputs.length,
      textured: outputs.some((item) => /painted|hy3dpaint|textured/i.test(item.label || item.fileName || item.serverPath || '')),
      raw: outputs.some((item) => /raw/i.test(item.label || item.fileName || item.serverPath || '')),
      candidates: outputs.slice(0, 4).map((item) => ({
        fileName: item.fileName,
        label: item.label,
        type: item.type || 'output',
        subfolder: item.subfolder || '',
      })),
    },
    recommendation: buildComfyDiagnosisRecommendation({ queueSummary, historyStatus, outputs }),
    checkedAt: new Date().toISOString(),
  }
}

export async function generateComfyUiModel(job, onProgress) {
  if (!job.referenceId) {
    throw Object.assign(new Error('缺少参考图，请先确认图片。'), { status: 400 })
  }

  const { record: reference, localPath: referencePath } = await getReferenceImage(job.referenceId)
  await onProgress({
    progress: Math.max(job.progress || 0, 34),
    stage: '已读取确认参考图，正在连接本地三维生成服务。',
    eventName: 'selfhost-3d-reference-loaded',
  })

  await fetchJson(`${COMFYUI_BASE_URL}/system_stats`, { timeoutMs: 20000 })
  const remoteImage = await uploadComfyImage(referencePath, reference)
  await onProgress({
    progress: Math.max(job.progress || 0, 42),
    stage: '参考图已上传到 ComfyUI，正在提交 TripoSG + Hunyuan3D-Paint 工作流。',
    eventName: 'selfhost-3d-reference-uploaded',
  })

  const prompt = await submitWorkflow(job, remoteImage)
  await onProgress({
    progress: Math.max(job.progress || 0, 52),
    stage: '三维生成任务已进入本地队列，正在等待几何与贴图输出。',
    eventName: 'selfhost-3d-submitted',
    patch: { providerJobId: prompt.promptId },
  })

  const historyItem = await pollHistory(prompt.promptId, async (progress, stage) => {
    await onProgress({ progress, stage, eventName: 'selfhost-3d-polling' })
  })

  return persistComfyUiOutputs(job, prompt.promptId, historyItem, onProgress)
}

export async function resumeComfyUiModel(job, onProgress) {
  if (!job.providerJobId) {
    throw Object.assign(new Error('缺少 ComfyUI prompt_id，无法续接本地三维任务。'), { status: 400 })
  }

  await onProgress({
    progress: Math.max(job.progress || 0, 55),
    stage: '服务已重启，正在根据 ComfyUI prompt_id 续接三维生成结果。',
    eventName: 'selfhost-3d-resume-started',
  })

  const historyItem = await pollHistory(job.providerJobId, async (progress, stage) => {
    await onProgress({
      progress: Math.max(progress, Math.max(job.progress || 0, 55)),
      stage,
      eventName: 'selfhost-3d-resume-polling',
    })
  })

  return persistComfyUiOutputs(job, job.providerJobId, historyItem, onProgress)
}

async function persistComfyUiOutputs(job, promptId, historyItem, onProgress) {
  const outputs = findGlbOutputs(historyItem)
  if (!outputs.length) {
    await saveHistory(job.id, promptId, historyItem)
    throw new Error('本地三维工作流已结束，但没有找到 GLB 输出。')
  }

  const selected = pickTexturedOutput(outputs)
  const raw = outputs.find((item) => /raw/i.test(item.label || item.fileName || item.serverPath || ''))

  await onProgress({
    progress: 86,
    stage: '已找到三维生成结果，正在下载并写入工作台模型缓存。',
    eventName: 'selfhost-3d-downloading',
  })

  await mkdir(LOCAL_MODEL_DIR, { recursive: true })
  const targetName = `${sanitizeModelId(`generated-${job.id}-${job.template}`)}.glb`
  const targetPath = path.join(LOCAL_MODEL_DIR, targetName)
  await downloadOutput(selected, targetPath)
  const buffer = await readFile(targetPath)
  validateModelBuffer(buffer, 'glb')

  let rawModelUrl
  if (raw && raw !== selected) {
    const rawName = `${sanitizeModelId(`raw-${job.id}-${job.template}`)}.glb`
    const rawPath = path.join(LOCAL_MODEL_DIR, rawName)
    await downloadOutput(raw, rawPath)
    rawModelUrl = `/api/3d/local-model/${encodeURIComponent(rawName)}`
  }

  await saveHistory(job.id, promptId, historyItem)
  const info = await stat(targetPath)

  return {
    id: `generated-${job.id}`,
    name: `AI 生成：${getTemplateDisplayName(job.template)}`,
    subtitle: '本地图生 3D 建模结果',
    category: 'AI 生成示意模型',
    accent: accentForTemplate(job.template),
    description: `根据「${job.prompt}」确认参考图后生成的本地三维模型。链路包含 GPT 参考图、TripoSG 几何重建与 Hunyuan3D-Paint 贴图处理。`,
    fileName: targetName,
    fileSize: info.size,
    imageHint: job.template,
    template: job.template,
    provider: '本地 TripoSG + Hunyuan3D-Paint',
    referenceImageUrl: job.referenceImageUrl,
    rawModelUrl,
    modelUrl: `/api/3d/local-model/${encodeURIComponent(targetName)}`,
  }
}

async function uploadComfyImage(imagePath, reference) {
  const imageBytes = await readFile(imagePath)
  const boundary = `----learningCellComfy${randomUUID().replace(/-/g, '')}`
  const remoteName = sanitizeFileName(`${reference.id}.${reference.ext || 'png'}`, 'reference.png')
  const subfolder = 'learningcell'
  const parts = []

  appendField(parts, boundary, 'type', 'input')
  appendField(parts, boundary, 'subfolder', subfolder)
  appendField(parts, boundary, 'overwrite', 'true')
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="image"; filename="${remoteName}"\r\n` +
        `Content-Type: ${reference.mimeType || 'image/png'}\r\n\r\n`
    )
  )
  parts.push(imageBytes)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

  const result = await fetchJson(`${COMFYUI_BASE_URL}/upload/image`, {
    method: 'POST',
    body: Buffer.concat(parts),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    timeoutMs: 120000,
  })

  const name = result.name || remoteName
  const folder = result.subfolder ?? subfolder
  return folder ? `${folder}/${name}` : name
}

function appendField(parts, boundary, name, value) {
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`
    )
  )
}

async function submitWorkflow(job, remoteImage) {
  const workflow = JSON.parse(await readFile(COMFYUI_WORKFLOW_TEMPLATE, 'utf8'))
  const prefix = sanitizeModelId(`learningcell-${job.id}`)
  workflow['1'].inputs.image = remoteImage
  workflow['2'].inputs.output_prefix = `${prefix}_raw`
  workflow['2'].inputs.num_inference_steps = COMFYUI_STEPS
  workflow['2'].inputs.guidance_scale = COMFYUI_GUIDANCE_SCALE
  workflow['2'].inputs.faces = COMFYUI_FACES
  workflow['3'].inputs.output_prefix = `${prefix}_painted`

  const payload = {
    client_id: randomUUID(),
    prompt: workflow,
  }
  const result = await fetchJson(`${COMFYUI_BASE_URL}/prompt`, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: 60000,
  })

  if (!result.prompt_id) throw new Error('ComfyUI 没有返回 prompt_id。')
  return { promptId: result.prompt_id }
}

async function pollHistory(promptId, onTick) {
  const deadline = Date.now() + COMFYUI_TIMEOUT_MS
  let tick = 0

  while (Date.now() < deadline) {
    await delay(COMFYUI_POLL_INTERVAL_MS)
    tick += 1
    const progress = Math.min(82, 52 + tick * 3)
    await onTick(progress, '本地三维服务正在输出几何与贴图，完成后会自动下载 GLB 并写入标本索引。')
    const historyUrl = `${COMFYUI_BASE_URL}/history/${encodeURIComponent(promptId)}`
    const history = await fetchJson(historyUrl, {
      timeoutMs: 60000,
      context: '查询 ComfyUI 任务历史',
    }).catch((error) => {
      if (isTransientComfyError(error) && tick <= COMFYUI_HISTORY_RETRY_LIMIT) return null
      throw error
    })
    if (!history) continue

    const item = history[promptId] || Object.values(history)[0]
    if (!item) continue

    const status = item.status || {}
    for (const message of status.messages || []) {
      const [event, data] = Array.isArray(message) ? message : []
      if (event === 'execution_error') {
        throw new Error(data?.exception_message || 'ComfyUI 执行工作流失败。')
      }
    }

    if (status.status_str && status.status_str !== 'success') {
      throw new Error(`ComfyUI 工作流状态异常：${status.status_str}`)
    }

    return item
  }

  throw Object.assign(new Error('本地三维生成超时，请检查 ComfyUI 队列或 GPU 服务状态。'), { status: 504 })
}

function findGlbOutputs(historyItem) {
  const outputs = []
  walk(historyItem, (value, key) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\/[^"'\n\r]+?\.glb/g)) {
        outputs.push({
          serverPath: match[0],
          fileName: path.basename(match[0]),
          label: `${key || ''} ${match[0]}`,
        })
      }
      if (/\.glb$/i.test(value) && !/[\\/"']/.test(value)) {
        outputs.push({
          fileName: value,
          subfolder: '',
          type: 'output',
          label: `${key || ''} ${value}`,
        })
      }
    }

    if (value && typeof value === 'object' && typeof value.filename === 'string' && /\.glb$/i.test(value.filename)) {
      outputs.push({
        fileName: value.filename,
        subfolder: value.subfolder || '',
        type: value.type || 'output',
        label: `${key || ''} ${value.filename}`,
      })
    }

    if (value && typeof value === 'object') {
      for (const field of ['model_file', 'model_3d', 'path']) {
        if (typeof value[field] === 'string' && /\.glb$/i.test(value[field])) {
          const candidate = value[field]
          outputs.push(
            candidate.startsWith('/')
              ? {
                  serverPath: candidate,
                  fileName: path.basename(candidate),
                  label: `${key || ''} ${field} ${candidate}`,
                }
              : {
                  fileName: path.basename(candidate),
                  subfolder: path.dirname(candidate) === '.' ? '' : path.dirname(candidate),
                  type: value.type || 'output',
                  label: `${key || ''} ${field} ${candidate}`,
                }
          )
        }
      }
    }
  })

  return dedupeOutputs(outputs)
}

function summarizeComfyQueue(queue, promptId) {
  if (queue?.error) {
    return {
      ok: false,
      running: 0,
      pending: 0,
      containsPrompt: false,
      message: queue.error,
    }
  }

  const runningItems = Array.isArray(queue?.queue_running) ? queue.queue_running : []
  const pendingItems = Array.isArray(queue?.queue_pending) ? queue.queue_pending : []
  const containsPrompt = [...runningItems, ...pendingItems].some((item) => JSON.stringify(item).includes(promptId))
  return {
    ok: true,
    running: runningItems.length,
    pending: pendingItems.length,
    containsPrompt,
    message: containsPrompt
      ? '远端队列仍包含该任务。'
      : runningItems.length || pendingItems.length
        ? '远端队列有其他任务，该任务暂未出现在队列摘要中。'
        : '远端队列为空，该任务可能已离队，需检查 history 输出。',
  }
}

function summarizeHistoryStatus(historyItem, historyError) {
  if (historyError) {
    return {
      ok: false,
      found: false,
      status: 'error',
      message: historyError,
    }
  }
  if (!historyItem) {
    return {
      ok: true,
      found: false,
      status: 'missing',
      message: 'history 暂未返回该 prompt_id，可能仍在远端写入或已被清理。',
    }
  }

  const status = historyItem.status || {}
  const statusText = status.status_str || 'unknown'
  const hasExecutionError = (status.messages || []).some((message) => {
    const [event] = Array.isArray(message) ? message : []
    return event === 'execution_error'
  })
  return {
    ok: !hasExecutionError && statusText !== 'error',
    found: true,
    status: hasExecutionError ? 'execution_error' : statusText,
    message: hasExecutionError
      ? 'history 已返回执行错误，请展开任务详情查看服务端错误。'
      : statusText === 'success'
        ? 'history 已返回成功状态，正在检查 GLB 输出。'
        : `history 已返回状态：${statusText}。`,
  }
}

function buildComfyDiagnosisRecommendation({ queueSummary, historyStatus, outputs }) {
  if (outputs.length) return 'history 已发现 GLB 输出，可点击“续接输出”下载并写入模型缓存。'
  if (historyStatus.found && historyStatus.status === 'success') return 'history 成功但未发现 GLB，建议检查 ComfyUI 工作流输出节点或 output_prefix。'
  if (!queueSummary.running && !queueSummary.pending && !historyStatus.found) return '远端队列为空且 history 暂缺，建议稍后再次诊断；若持续如此，可能需要检查远端 history 保留策略。'
  if (queueSummary.containsPrompt) return '远端队列仍包含该任务，请等待或稍后同步状态。'
  return '请保持任务记录，可稍后点击“诊断远端”或“续接输出”。'
}

function shortPromptId(promptId) {
  return String(promptId || '').slice(-8).toUpperCase() || 'COMFYUI'
}

function walk(value, visit, key = '') {
  visit(value, key)
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${key}.${index}`))
  } else if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      walk(childValue, visit, key ? `${key}.${childKey}` : childKey)
    }
  }
}

function dedupeOutputs(outputs) {
  const seen = new Set()
  return outputs.filter((item) => {
    const key = item.serverPath || `${item.subfolder}/${item.fileName}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function pickTexturedOutput(outputs) {
  return (
    outputs.find((item) => /painted|hy3dpaint|textured/i.test(item.label || item.fileName || item.serverPath || '')) ||
    outputs.find((item) => !/raw/i.test(item.label || item.fileName || item.serverPath || '')) ||
    outputs[0]
  )
}

async function downloadOutput(output, targetPath) {
  const url = output.serverPath ? outputPathToViewUrl(output.serverPath) : outputObjectToViewUrl(output)
  const response = await fetchWithRetry(url, {
    timeoutMs: 120000,
    retries: COMFYUI_DOWNLOAD_RETRY_LIMIT,
    context: '下载 ComfyUI GLB 输出',
  })
  const tmpPath = `${targetPath}.downloading`
  await writeFile(tmpPath, Buffer.from(await response.arrayBuffer()))
  await rename(tmpPath, targetPath)
}

function outputPathToViewUrl(serverPath) {
  const relative = serverPath.startsWith(COMFYUI_OUTPUT_PREFIX)
    ? serverPath.slice(COMFYUI_OUTPUT_PREFIX.length)
    : path.basename(serverPath)
  const subfolder = path.dirname(relative) === '.' ? '' : path.dirname(relative)
  const fileName = path.basename(relative)
  const query = new URLSearchParams({ filename: fileName, subfolder, type: 'output' })
  return `${COMFYUI_BASE_URL}/view?${query.toString()}`
}

function outputObjectToViewUrl(output) {
  const query = new URLSearchParams({
    filename: output.fileName,
    subfolder: output.subfolder || '',
    type: output.type || 'output',
  })
  return `${COMFYUI_BASE_URL}/view?${query.toString()}`
}

async function saveHistory(jobId, promptId, historyItem) {
  await mkdir(WORKFLOW_STORE_DIR, { recursive: true })
  const fileName = sanitizeFileName(`comfyui-${jobId}-${promptId}.json`)
  await writeFile(path.join(WORKFLOW_STORE_DIR, fileName), JSON.stringify(historyItem, null, 2))
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30000, context = '请求 ComfyUI' } = {}) {
  const response = await fetchWithRetry(url, {
    method,
    headers,
    body,
    timeoutMs,
    context,
    retries: method === 'GET' ? 2 : 0,
  })
  const text = await response.text()
  const payload = text ? parseJsonPayload(text, context) : {}
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error?.message || payload?.error || `${context}失败：HTTP ${response.status}`), {
      status: response.status,
      detail: payload,
      endpoint: scrubComfyEndpoint(url),
    })
  }
  return payload
}

async function fetchWithRetry(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 30000,
  retries = 0,
  context = '请求 ComfyUI',
} = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      })
      if (response.ok || attempt >= retries || !isRetryableStatus(response.status)) return response
      lastError = Object.assign(new Error(`${context}失败：HTTP ${response.status}`), {
        status: response.status,
        endpoint: scrubComfyEndpoint(url),
      })
    } catch (error) {
      lastError = normalizeComfyFetchError(error, context, url)
      if (attempt >= retries || !isTransientComfyError(error)) throw lastError
    } finally {
      clearTimeout(timeout)
    }
    await delay(Math.min(6000, 700 * (attempt + 1)))
  }
  throw lastError || new Error(`${context}失败。`)
}

function parseJsonPayload(text, context) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw Object.assign(new Error(`${context}返回了无法解析的 JSON。`), {
      cause: error,
      detail: text.slice(0, 240),
    })
  }
}

export function normalizeComfyFetchError(error, context = '请求 ComfyUI', url = COMFYUI_BASE_URL) {
  const endpoint = scrubComfyEndpoint(url)
  if (error?.name === 'AbortError') {
    return Object.assign(new Error(`${context}超时，请检查 3D 服务队列或稍后同步状态。`), {
      cause: error,
      endpoint,
    })
  }
  const reason = error?.cause?.code || error?.code || error?.message || '网络请求失败'
  return Object.assign(new Error(`${context}失败：${reason}。请确认 3D 服务仍可访问，稍后可点击“同步状态”续接任务。`), {
    cause: error,
    endpoint,
  })
}

export function isTransientComfyError(error) {
  const message = [
    error?.name,
    error?.code,
    error?.message,
    error?.cause?.code,
    error?.cause?.message,
  ].filter(Boolean).join(' ')
  return /AbortError|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|network|socket|terminated|other side closed/i.test(message)
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export function scrubComfyEndpoint(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return String(url).split('?')[0]
  }
}

function accentForTemplate(template) {
  const accents = {
    'plant-cell': '#7fb069',
    'animal-cell': '#e8859a',
    'white-blood-cell': '#c8a2d8',
    neuron: '#f0a868',
    dna: '#9cc4e4',
    mitochondrion: '#d8844c',
    chloroplast: '#6fa55d',
    bacterium: '#5b9aa8',
  }
  return accents[template] || '#7fb069'
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
