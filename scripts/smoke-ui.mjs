import { readFile } from 'node:fs/promises'
import '../server/env-loader.mjs'

const API_BASE = (process.env.SMOKE_API_BASE || `http://${process.env.API_HOST || '127.0.0.1'}:${process.env.API_PORT || 8791}`).replace(/\/$/, '')
const APP_BASE = (process.env.SMOKE_APP_BASE || 'http://127.0.0.1:5173').replace(/\/$/, '')
const MIN_DEMO_MODELS = Number(process.env.SMOKE_MIN_DEMO_MODELS || 1)
const API_RETRY_COUNT = Number(process.env.SMOKE_API_RETRY_COUNT || 2)
const API_RETRY_DELAY_MS = Number(process.env.SMOKE_API_RETRY_DELAY_MS || 180)
const UI_SOURCE_FILES = [
  'app/src/components/GenerationPanel.tsx',
  'app/src/components/TaskWatchCard.tsx',
  'app/src/components/Sidebar.tsx',
  'app/src/components/ModelViewer.tsx',
  'app/src/components/ProgressOverlay.tsx',
  'app/src/lib/modelWeight.ts',
  'app/src/lib/jobHistory.ts',
  'app/src/lib/workflowWait.ts',
  'app/src/lib/workflowTimeline.ts',
  'app/src/lib/workflowPreflight.ts',
  'app/src/lib/workflowRuntime.ts',
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
      'task-watch-diagnostics',
      'task-watch-strategy',
      'task-watch-compact-main',
      'task-watch-compact-actions',
      'task-watch-live-summary',
      'toggle-active-job-detail',
      'workflow-phase-board',
      'workflow-next-action',
      'workflow-next-action-button',
      'generation-action-status',
      'generation-path-strategy',
      '当前建议',
      'is-recommended',
      'workflow-preflight-card',
      'refresh-provider-status',
      'prompt-approval-card',
      'regenerate-prompt',
      'confirm-prompt',
      'prompt-preview-card',
      'generation-inspector',
      'generation-inspector-body',
      '链路巡检',
      'runtime-rail',
      '图片网关',
      '保护队列',
      'RAM 余量',
      'GPU 余量',
      '资源保护',
      '安全线',
      'local-chain-proof',
      'reference-gate-card',
      'reference-quality-gate',
      'accept-reference-gate',
      'retry-reference-gate',
      'confirm-modeling-gate',
      'job-history-compact',
      'sync-active-job',
      'resume-active-job',
      'diagnose-active-job',
      'generation-timeline',
      'job-result-review',
      'model-output-chain',
      'texture-result-status',
      'texture-mode-safety',
      'texture-submit-strategy',
      'chain-readiness',
      'chain-readiness-badge',
      'texture-artifact-health',
      'refresh-texture-artifacts',
      'texture-artifact-checked-at',
      'texture-artifact-feedback',
      'texture-artifact-latest',
      'texture-artifact-open-model',
      'texture-stability-preflight-card',
      'run-texture-stability',
      'run-texture-fallback-long-check',
      'texture-stability-latest',
      'texture-stability-latest-detail',
      'texture-stability-feedback',
      'texture-stability-feedback-detail',
      'texture-stability-checked-at',
      'texture-stability-checked-at-detail',
      'texture-stability-path-strip',
      'texture-artifact-path-strip',
      '贴图产物健康',
      '贴图资源安全边界',
      '贴图提交策略',
      '本次 3D 路径',
      '可试跑混元',
      'fallback 优先',
      '连续白模换原贴图',
      '最新产物',
      '打开 GLB',
      '只读刷新',
      '只读检查现有 GLB',
      '只读预检',
      '轻量长测',
      '不提交重任务',
      'active material',
      '原生混元贴图已返回',
      '稳定 fallback 彩色版',
      '当前可用彩色版',
      '原生混元状态',
      '贴图增强未完整返回',
      '近期缓存',
      'reference-output-link',
      'raw-output-link',
      'textured-output-link',
      'final-output-link',
      'review-view-model',
      'review-open-reference',
      'review-download-model',
      'review-copy-prompt',
      'run-full-workflow',
      'confirm-modeling',
      'specimen-index-card',
      'specimen-concept-card',
      'model-viewer',
      'stage-order-card',
      'stage-concept-card',
      'stage-learning-rail',
      'stage-question-drawer',
      'stage-load-note',
      'progress-model-weight',
      '生成参考图',
      '完整生成',
      '确认建模',
      'Prompt',
      '可预览',
      '待确认',
      '参考图',
      '图生 3D',
      '结果入库',
      '上传图片',
      '重试图片',
      '生成规格',
      '快速预览',
      '标准教学',
      '精细单图',
      '1536x1536',
      '非4K',
      '默认链路',
      '48760 本地图片网关',
      'health 可用，models 暂未返回',
      '图片上游',
      '上游需检查',
      '概念速读',
      '生成复盘',
      '3D 输出链路',
      '本地演示链路',
      '参考图缓存',
      '缓存 GLB',
      '当前展示',
      'Textured GLB',
      '下载 GLB',
      '复制 Prompt',
      '模型文件',
      '加载提示',
      '重模型',
      '已启用轻量渲染并保留光影',
      '备用异常',
      '后台仍在生成',
      '可稍后恢复',
      '建议同步状态',
      '自动轮询',
      '远端ID已保存',
      '贴图/GLB',
      '续接输出',
      '远端任务',
      '远端诊断',
      '诊断远端',
      '82% 附近',
      'history 清理后',
      '可续接',
      '队列摘要',
      '固定显示当前关键任务',
      '队列只展示关键任务摘要',
      '固定摘要，不向下增长',
      '最近 2 条',
      '已收纳',
      '完整记录保留在本地任务接口',
      '重新生成',
      '确认提示词',
      '预览提示词',
      '提示词工序',
      '检查构图、剖面和白底单图要求',
      '参考图验收',
      '确认单主体、剖面清晰、白底留白充足',
      '本地链路',
      'TripoSG raw',
      '生成路线',
      '阶段看板',
      '链路预检',
      '链路就绪',
      '文生图到图生 3D',
      '提示词',
      '参考图',
      '图生3D',
      '贴图兜底',
      '正在同步链路状态',
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

  await step('巡检面板有界滚动', async () => {
    const cssText = await readFile('app/src/app.css', 'utf8')
    const requiredSnippets = [
      '.generation-inspector-body',
      'max-height: clamp(260px, 42vh, 420px)',
      'overflow-y: auto',
      'overscroll-behavior: contain',
      '.generation-inspector:not([open]) .generation-inspector-body',
      'display: none',
    ]
    for (const snippet of requiredSnippets) {
      assertIncludes(cssText, snippet, `巡检面板有界滚动缺少样式：${snippet}`)
    }
    return {
      guard: 'bounded-inspector-scroll',
      checked: requiredSnippets.length,
    }
  })

  await step('生成工坊辅助操作紧凑布局', async () => {
    const cssText = await readFile('app/src/app.css', 'utf8')
    const requiredSnippets = [
      '.generation-action-secondary',
      'grid-template-columns: repeat(3, minmax(0, 1fr))',
      'grid-template-columns: repeat(2, minmax(0, 1fr))',
      'min-height: 26px',
      'font-size: 7.6px',
      'transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1)',
      'scale(1.006)',
      'scale(0.995)',
    ]
    for (const snippet of requiredSnippets) {
      assertIncludes(cssText, snippet, `生成工坊辅助操作紧凑布局缺少样式：${snippet}`)
    }
    return {
      guard: 'compact-secondary-action-strip',
      checked: requiredSnippets.length,
    }
  })

  await step('加载态舞台控件隔离', async () => {
    const sourceText = await readFile('app/src/components/ModelViewer.tsx', 'utf8')
    const requiredSnippets = [
      'const showStageUi = isReady',
      "showStageUi ? ' is-model-ready' : ' is-model-loading'",
      'if (!showStageUi)',
      '{showStageUi && (',
      'data-testid="stage-learning-rail"',
      'className="stage-control-strip"',
      'data-testid="stage-question-drawer"',
      '!isReady && (',
    ]
    for (const snippet of requiredSnippets) {
      assertIncludes(sourceText, snippet, `加载态隔离缺少实现片段：${snippet}`)
    }
    const protectedLabels = ['观察顺序', '概念图解', '提问线索', '自动旋转', '复位', '全局']
    for (const label of protectedLabels) {
      const labelIndex = sourceText.indexOf(label)
      const guardIndex = sourceText.lastIndexOf('{showStageUi && (', labelIndex)
      const progressIndex = sourceText.lastIndexOf('<ProgressOverlay', labelIndex)
      if (labelIndex === -1 || guardIndex === -1 || progressIndex > guardIndex) {
        throw new Error(`加载态可能仍会露出舞台控件：${label}`)
      }
    }
    return {
      protectedLabels,
      guard: 'showStageUi',
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
  let lastError
  for (let attempt = 0; attempt <= API_RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}${path}`)
      const raw = await response.text()
      let payload
      try {
        payload = raw ? JSON.parse(raw) : {}
      } catch (error) {
        const preview = raw.slice(0, 160).replace(/\s+/g, ' ')
        throw new Error(`JSON 解析失败：${error.message}${preview ? `；响应片段：${preview}` : ''}`)
      }
      if (!response.ok || payload.error) {
        throw new Error(payload.error || `HTTP ${response.status}`)
      }
      return payload
    } catch (error) {
      lastError = error
      if (!isRetryableApiSmokeError(error) || attempt >= API_RETRY_COUNT) break
      await delay(API_RETRY_DELAY_MS * (attempt + 1))
    }
  }
  throw lastError
}

function isRetryableApiSmokeError(error) {
  return /JSON 解析失败|Unexpected end of JSON input|terminated|ECONNRESET|socket hang up/i.test(error?.message || '')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
