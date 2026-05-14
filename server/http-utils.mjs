import { BODY_LIMIT } from './config.mjs'

export function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(payload, null, 2))
}

export async function readJsonBody(request, limit = BODY_LIMIT) {
  const buffer = await readRawBody(request, limit)
  if (!buffer.length) return {}

  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON。'), { status: 400 })
  }
}

export function readRawBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0

    request.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(Object.assign(new Error('上传文件过大。'), { status: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

export function sanitizeFileName(value, fallback = 'model.glb') {
  const cleaned = String(value || '')
    .replace(/[\\/]/g, '')
    .replace(/[^\w\u4e00-\u9fa5 .-]/g, '')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)

  return cleaned || fallback
}
