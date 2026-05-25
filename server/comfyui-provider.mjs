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

export async function generateComfyUiModel(job, onProgress) {
  if (!job.referenceId) {
    throw Object.assign(new Error('缺少参考图，请先确认图片。'), { status: 400 })
  }

  const { record: reference, localPath: referencePath } = await getReferenceImage(job.referenceId)
  await onProgress({
    progress: 14,
    stage: '已读取确认参考图，正在连接本地三维生成服务。',
    eventName: 'selfhost-3d-reference-loaded',
  })

  await fetchJson(`${COMFYUI_BASE_URL}/system_stats`, { timeoutMs: 20000 })
  const remoteImage = await uploadComfyImage(referencePath, reference)
  await onProgress({
    progress: 28,
    stage: '参考图已上传到 ComfyUI，正在提交 TripoSG + Hunyuan3D-Paint 工作流。',
    eventName: 'selfhost-3d-reference-uploaded',
  })

  const prompt = await submitWorkflow(job, remoteImage)
  await onProgress({
    progress: 42,
    stage: '三维生成任务已进入本地队列，正在等待几何与贴图输出。',
    eventName: 'selfhost-3d-submitted',
    patch: { providerJobId: prompt.promptId },
  })

  const historyItem = await pollHistory(prompt.promptId, async (progress, stage) => {
    await onProgress({ progress, stage, eventName: 'selfhost-3d-polling' })
  })

  const outputs = findGlbOutputs(historyItem)
  if (!outputs.length) {
    await saveHistory(job.id, prompt.promptId, historyItem)
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

  await saveHistory(job.id, prompt.promptId, historyItem)
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
    const progress = Math.min(80, 42 + tick * 3)
    await onTick(progress, '本地三维服务正在生成模型，请保持服务在线。')
    const history = await fetchJson(`${COMFYUI_BASE_URL}/history/${encodeURIComponent(promptId)}`, {
      timeoutMs: 60000,
    }).catch((error) => {
      if (error.name === 'AbortError') return null
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
    }

    if (value && typeof value === 'object' && typeof value.filename === 'string' && /\.glb$/i.test(value.filename)) {
      outputs.push({
        fileName: value.filename,
        subfolder: value.subfolder || '',
        type: value.type || 'output',
        label: `${key || ''} ${value.filename}`,
      })
    }
  })

  return dedupeOutputs(outputs)
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
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载 GLB 失败：${response.status}`)
  const tmpPath = `${targetPath}.downloading`
  await writeFile(tmpPath, Buffer.from(await response.arrayBuffer()))
  await rename(tmpPath, targetPath)
}

function outputPathToViewUrl(serverPath) {
  if (!serverPath.startsWith(COMFYUI_OUTPUT_PREFIX)) {
    throw new Error(`ComfyUI 输出路径不在允许目录：${serverPath}`)
  }
  const relative = serverPath.slice(COMFYUI_OUTPUT_PREFIX.length)
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

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    })
    const payload = await response.json().catch(async () => ({ error: await response.text() }))
    if (!response.ok) {
      throw Object.assign(new Error(payload?.error?.message || payload?.error || `HTTP ${response.status}`), {
        status: response.status,
        detail: payload,
      })
    }
    return payload
  } finally {
    clearTimeout(timeout)
  }
}

function accentForTemplate(template) {
  const accents = {
    'plant-cell': '#7fb069',
    'animal-cell': '#e8859a',
    'white-blood-cell': '#c8a2d8',
    neuron: '#f0a868',
    dna: '#9cc4e4',
  }
  return accents[template] || '#7fb069'
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
