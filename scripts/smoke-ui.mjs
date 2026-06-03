import { readFile } from 'node:fs/promises'
import '../server/env-loader.mjs'

const API_BASE = (process.env.SMOKE_API_BASE || `http://${process.env.API_HOST || '127.0.0.1'}:${process.env.API_PORT || 8791}`).replace(/\/$/, '')
const APP_BASE = (process.env.SMOKE_APP_BASE || 'http://127.0.0.1:5173').replace(/\/$/, '')
const MIN_DEMO_MODELS = Number(process.env.SMOKE_MIN_DEMO_MODELS || 1)
const UI_SOURCE_FILES = [
  'app/src/components/GenerationPanel.tsx',
  'app/src/components/Sidebar.tsx',
  'app/src/components/ModelViewer.tsx',
  'app/src/components/ProgressOverlay.tsx',
  'app/src/lib/modelWeight.ts',
  'app/src/lib/jobHistory.ts',
  'app/src/lib/workflowWait.ts',
  'app/src/lib/workflowTimeline.ts',
  'app/src/data/models.ts',
]

const report = []

async function main() {
  let entryHtml = ''
  await step('前端入口', async () => {
    const response = await fetch(`${APP_BASE}/`)
    if (!response.ok) throw new Error(`前端入口不可访问：${response.status}`)
    const text = await response.text()
    entryHtml = text
    assertIncludes(text, '<div id="root">', '缺少 React root')
    assertIncludes(text, '间 MA 生物工作台', '缺少页面标题')
    return {
      bytes: Buffer.byteLength(text),
      title: pickTitle(text),
    }
  })

  await step('构建产物关键文案', async () => {
    const scripts = extractScriptUrls(entryHtml).slice(0, 3)
    if (!scripts.length) throw new Error('前端入口没有找到脚本产物')
    const bundleText = (await Promise.all(scripts.map(fetchText))).join('\n')
    const sourceText = (await Promise.all(UI_SOURCE_FILES.map((file) => readFile(file, 'utf8')))).join('\n')
    const searchableText = `${bundleText}\n${sourceText}`
    const required = [
      'data-testid',
      'generation-panel',
      'task-watch-card',
      'task-watch-wait',
      'task-watch-recovery',
      'sync-active-job',
      'resume-active-job',
      'generation-timeline',
      'job-result-review',
      'review-view-model',
      'review-open-reference',
      'review-download-model',
      'review-copy-prompt',
      'run-full-workflow',
      'confirm-modeling',
      'specimen-index-card',
      'specimen-concept-card',
      'model-viewer',
      'stage-load-note',
      'progress-model-weight',
      '生成参考图',
      '完整生成',
      '确认建模',
      '上传图片',
      '重试图片',
      '生成规格',
      '快速预览',
      '标准教学',
      '精细单图',
      '1536x1536',
      '默认链路',
      '48760 本地图片网关',
      '概念速读',
      '生成复盘',
      '下载 GLB',
      '复制 Prompt',
      '模型文件',
      '加载提示',
      '重模型',
      '后台仍在生成',
      '可稍后恢复',
      '建议同步状态',
      '续接输出',
      '远端任务',
      '可续接',
      '队列只展示关键 3 条',
      '生成路线',
      '等待接收图片',
      '正在图生3D',
      '模型已入库',
      'ATP',
      '光合作用',
    ]
    for (const text of required) assertIncludes(searchableText, text, `缺少 UI 标识或文案：${text}`)
    return {
      checked: required.length,
      scripts,
    }
  })

  const jobsPayload = await step('最新生成任务', async () => {
    const payload = await api('/api/jobs?limit=8')
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : []
    const completed = jobs.find((job) => job.status === 'completed' && job.result?.modelUrl)
    if (!completed) throw new Error('没有可用于 UI 恢复的已完成任务')
    return {
      total: jobs.length,
      latest: {
        id: completed.id,
        template: completed.template,
        workflowMode: completed.workflowMode,
        imageProvider: completed.imageProvider,
        provider: completed.provider,
        progress: completed.progress,
        referenceId: completed.referenceId,
        modelUrl: completed.result.modelUrl,
      },
    }
  })

  await step('最新任务资产', async () => {
    const latest = jobsPayload.latest
    const modelResponse = await fetchUrl(latest.modelUrl)
    const signature = Buffer.from(await modelResponse.arrayBuffer()).subarray(0, 4).toString('ascii')
    if (signature !== 'glTF') throw new Error(`最新 GLB 文件头异常：${signature}`)

    let referenceOk = false
    if (latest.referenceId) {
      const referenceResponse = await fetchUrl(`/api/references/${encodeURIComponent(latest.referenceId)}/image`)
      const head = Buffer.from(await referenceResponse.arrayBuffer()).subarray(0, 8)
      referenceOk = isPng(head) || isJpeg(head)
    }

    return {
      signature,
      referenceOk,
    }
  })

  await step('标本索引数据容量', async () => {
    const payload = await api('/api/3d/demo-models')
    const models = Array.isArray(payload.models) ? payload.models : []
    if (models.length < MIN_DEMO_MODELS) {
      throw new Error(`缓存模型数量不足：${models.length}/${MIN_DEMO_MODELS}`)
    }
    return {
      models: models.length,
      latestGenerated: jobsPayload.latest.id,
      sample: models.slice(0, 3).map((model) => model.name),
    }
  })

  console.log(JSON.stringify({ ok: true, appBase: APP_BASE, apiBase: API_BASE, report }, null, 2))
}

async function step(name, fn) {
  const started = Date.now()
  try {
    const result = await fn()
    report.push({ name, ok: true, ms: Date.now() - started, result })
    return result
  } catch (error) {
    report.push({ name, ok: false, ms: Date.now() - started, error: error.message })
    console.error(JSON.stringify({ ok: false, appBase: APP_BASE, apiBase: API_BASE, report }, null, 2))
    process.exitCode = 1
    throw error
  }
}

async function api(path) {
  const response = await fetch(`${API_BASE}${path}`)
  const payload = await response.json().catch(async () => ({ error: await response.text() }))
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `HTTP ${response.status}`)
  }
  return payload
}

async function fetchText(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} 不可访问：${response.status}`)
  return response.text()
}

async function fetchUrl(path) {
  const response = await fetch(/^https?:\/\//i.test(path) ? path : `${API_BASE}${path}`)
  if (!response.ok) throw new Error(`${path} 不可访问：${response.status}`)
  return response
}

function assertIncludes(text, needle, message) {
  if (!text.includes(needle)) throw new Error(message)
}

function pickTitle(html) {
  return html.match(/<title>(.*?)<\/title>/i)?.[1] || ''
}

function extractScriptUrls(html) {
  return [...html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((match) => {
    const src = match[1]
    if (/^https?:\/\//i.test(src)) return src
    if (src.startsWith('/')) return `${APP_BASE}${src}`
    return `${APP_BASE}/${src.replace(/^\.\//, '')}`
  })
}

function isPng(buffer) {
  return buffer.length >= 8 && buffer[0] === 0x89 && buffer.subarray(1, 4).toString('ascii') === 'PNG'
}

function isJpeg(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
}

main().catch((error) => {
  console.error(error.message)
})
