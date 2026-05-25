import { createReadStream } from 'node:fs'
import { access, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  CELLFORGE_MODEL_DIR,
  DEMO_MODELS,
  LOCAL_MODEL_DIR,
  MODEL_UPLOAD_LIMIT,
  UPLOAD_CACHE_DIR,
  UPLOAD_TRASH_DIR,
  UPLOAD_WORK_DIR,
} from './config.mjs'
import { readRawBody, sanitizeFileName } from './http-utils.mjs'

export async function getDemoModels() {
  const models = []

  for (const item of DEMO_MODELS) {
    const filePath = path.join(CELLFORGE_MODEL_DIR, item.fileName)
    try {
      const info = await stat(filePath)
      models.push({
        ...item,
        fileSize: info.size,
        provider: '3DCellForge',
        modelUrl: `/api/3d/demo-model/${encodeURIComponent(item.fileName)}`,
      })
    } catch {
      models.push({
        ...item,
        fileSize: 0,
        provider: '3DCellForge',
        missing: true,
        modelUrl: '',
      })
    }
  }

  return models
}

export async function serveDemoModel(url, response) {
  const fileName = sanitizeFileName(decodeURIComponent(url.pathname.replace('/api/3d/demo-model/', '')))
  const allowed = DEMO_MODELS.some((model) => model.fileName === fileName)
  if (!allowed) {
    throw Object.assign(new Error('示例模型不存在。'), { status: 404 })
  }

  await streamModelFile(path.join(CELLFORGE_MODEL_DIR, fileName), response)
}

export async function importLocalModel(request, url) {
  const fileName = sanitizeFileName(url.searchParams.get('fileName') || 'local-model.glb')
  const ext = getModelExtension(fileName)
  const buffer = await readRawBody(request, MODEL_UPLOAD_LIMIT)
  validateModelBuffer(buffer, ext)

  await Promise.all([
    mkdir(LOCAL_MODEL_DIR, { recursive: true }),
    mkdir(UPLOAD_WORK_DIR, { recursive: true }),
    mkdir(UPLOAD_CACHE_DIR, { recursive: true }),
    mkdir(UPLOAD_TRASH_DIR, { recursive: true }),
  ])
  const baseName = fileName.replace(/\.(?:glb|gltf)$/i, '') || 'local-model'
  const modelId = sanitizeModelId(`local-${Date.now()}-${baseName}`)
  const targetName = `${modelId}.${ext}`
  const workPath = path.join(UPLOAD_WORK_DIR, `${targetName}.uploading`)
  const cachePath = path.join(UPLOAD_CACHE_DIR, targetName)
  const targetPath = path.join(LOCAL_MODEL_DIR, targetName)

  try {
    await writeFile(workPath, buffer)
    validateModelBuffer(await readFile(workPath), ext)
    await rename(workPath, cachePath)
    await copyFile(cachePath, targetPath)
  } catch (error) {
    await moveFailedUpload(workPath, targetName)
    throw error
  }

  return {
    id: modelId,
    name: trimModelName(baseName),
    fileName,
    fileSize: buffer.length,
    provider: 'Local GLB',
    status: 'success',
    cacheState: {
      workDir: UPLOAD_WORK_DIR,
      cacheDir: UPLOAD_CACHE_DIR,
      modelDir: LOCAL_MODEL_DIR,
      trashDir: UPLOAD_TRASH_DIR,
    },
    modelUrl: `/api/3d/local-model/${encodeURIComponent(targetName)}`,
  }
}

export async function serveLocalModel(url, response) {
  const fileName = sanitizeFileName(decodeURIComponent(url.pathname.replace('/api/3d/local-model/', '')))
  await streamModelFile(path.join(LOCAL_MODEL_DIR, fileName), response)
}

export function getModelExtension(value) {
  const ext = path.extname(String(value || '')).replace('.', '').toLowerCase()
  if (ext === 'glb' || ext === 'gltf') return ext
  throw Object.assign(new Error('当前仅支持 GLB 或自包含 GLTF 模型。'), { status: 400 })
}

export function validateModelBuffer(buffer, ext = 'glb') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) {
    throw Object.assign(new Error('模型文件过小或格式无效。'), { status: 400 })
  }

  if (ext === 'glb') {
    if (buffer.subarray(0, 4).toString('ascii') !== 'glTF') {
      throw Object.assign(new Error('GLB 文件必须包含 glTF 二进制文件头。'), { status: 400 })
    }
    return
  }

  try {
    JSON.parse(buffer.toString('utf8'))
  } catch {
    throw Object.assign(new Error('GLTF 文件必须是合法 JSON。'), { status: 400 })
  }
}

export function sanitizeModelId(value) {
  return sanitizeFileName(String(value || ''), `model-${Date.now()}`)
    .replace(/\.(?:glb|gltf)$/i, '')
    .replace(/\s+/g, '-')
    .slice(0, 96)
}

function trimModelName(value) {
  const cleaned = String(value || '导入模型').replace(/[-_]+/g, ' ').trim()
  return cleaned.length > 22 ? `${cleaned.slice(0, 22)}...` : cleaned
}

async function streamModelFile(filePath, response) {
  await access(filePath)
  const ext = getModelExtension(filePath)
  const info = await stat(filePath)

  response.writeHead(200, {
    'Content-Type': ext === 'gltf' ? 'model/gltf+json' : 'model/gltf-binary',
    'Content-Length': info.size,
    'Cache-Control': 'private, max-age=3600',
  })

  createReadStream(filePath).pipe(response)
}

async function moveFailedUpload(workPath, targetName) {
  try {
    await access(workPath)
    await rename(workPath, path.join(UPLOAD_TRASH_DIR, `${targetName}.failed-${Date.now()}`))
  } catch {
    // Ignore cleanup failures; upload validation error is more useful to callers.
  }
}

export async function inspectLocalModel(fileName) {
  const safeName = sanitizeFileName(fileName)
  const filePath = path.join(LOCAL_MODEL_DIR, safeName)
  const buffer = await readFile(filePath)
  validateModelBuffer(buffer, getModelExtension(safeName))
  return { fileName: safeName, fileSize: buffer.length }
}
