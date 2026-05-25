import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  CELLFORGE_MODEL_DIR,
  DEMO_MODELS,
  LOCAL_MODEL_DIR,
  MOCK_WORKFLOW_STEP_DELAY,
  TENCENT_HUNYUAN_CONFIGURED,
} from './config.mjs'
import { sanitizeModelId } from './model-store.mjs'
import { getTemplateDisplayName } from './workflow-utils.mjs'
import { updateWorkflowJob } from './job-store.mjs'
import { generateComfyUiModel } from './comfyui-provider.mjs'

export function startWorkflowJob(job) {
  if (job.provider === 'tencent-hunyuan' && !TENCENT_HUNYUAN_CONFIGURED) {
    void updateWorkflowJob(
      job.id,
      {
        status: 'failed',
        progress: 100,
        stage: '腾讯混元生 3D provider 尚未配置，请切换到本地三维生成或本地缓存链路。',
        error: '缺少 TENCENT_SECRET_ID、TENCENT_SECRET_KEY 或 TENCENT_HUNYUAN_3D_ENDPOINT。',
      },
      'provider-not-configured'
    )
    return
  }

  const runner = job.provider === 'selfhost-triposg' ? runSelfHostedWorkflow : runLocalDemoWorkflow

  void runner(job).catch((error) => {
    void updateWorkflowJob(
      job.id,
      {
        status: 'failed',
        progress: 100,
        stage: '生成任务失败。',
        error: error.message || '本地生成工作流执行失败。',
      },
      'failed'
    )
  })
}

async function runSelfHostedWorkflow(job) {
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 8,
      stage: '参考图已确认，正在准备本地 TripoSG + Hunyuan3D-Paint 工作流。',
    },
    'selfhost-3d-started'
  )

  const result = await generateComfyUiModel(job, async ({ progress, stage, eventName, patch = {} }) => {
    await updateWorkflowJob(
      job.id,
      {
        status: 'processing',
        progress,
        stage,
        ...patch,
      },
      eventName
    )
  })

  await updateWorkflowJob(
    job.id,
    {
      status: 'completed',
      progress: 100,
      stage: '本地图生 3D 已完成，模型已写入缓存并加入标本索引。',
      result,
    },
    'completed'
  )
}

async function runLocalDemoWorkflow(job) {
  await delay(MOCK_WORKFLOW_STEP_DELAY)
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 22,
      stage: '已接收确认参考图，正在整理适合图生 3D 的结构描述。',
    },
    'prompt-refined'
  )

  await delay(MOCK_WORKFLOW_STEP_DELAY)
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 48,
      stage: '参考图预处理已完成，正在提交本地缓存建模链路。',
    },
    'reference-image-ready'
  )

  const demoModel = pickDemoModel(job.template)
  const sourcePath = path.join(CELLFORGE_MODEL_DIR, demoModel.fileName)
  await stat(sourcePath)

  await delay(MOCK_WORKFLOW_STEP_DELAY)
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 76,
      stage: '正在写入本地 GLB 缓存，准备交给 LearningCell 查看器。',
    },
    'model-caching'
  )

  await mkdir(LOCAL_MODEL_DIR, { recursive: true })
  const targetName = `${sanitizeModelId(`generated-${job.id}-${job.template}`)}.glb`
  const targetPath = path.join(LOCAL_MODEL_DIR, targetName)
  await copyFile(sourcePath, targetPath)
  const info = await stat(targetPath)

  await delay(Math.round(MOCK_WORKFLOW_STEP_DELAY * 0.6))
  await updateWorkflowJob(
    job.id,
    {
      status: 'completed',
      progress: 100,
      stage: '生成模型已完成，可在标本索引中打开。',
      result: {
        id: `generated-${job.id}`,
        name: `AI 生成：${getTemplateDisplayName(job.template)}`,
        subtitle: '图生 3D 建模结果',
        category: 'AI 生成示意模型',
        accent: demoModel.accent,
        description: `根据「${job.prompt}」确认参考图后进入本地缓存链路，可用于课堂中快速验证参考图、任务记录、模型缓存与 3D 舞台展示。`,
        fileName: targetName,
        fileSize: info.size,
        imageHint: job.template,
        template: job.template,
        provider: '本地缓存链路',
        referenceImageUrl: job.referenceImageUrl,
        modelUrl: `/api/3d/local-model/${encodeURIComponent(targetName)}`,
      },
    },
    'completed'
  )
}

function pickDemoModel(template) {
  if (template === 'plant-cell') return DEMO_MODELS[0]
  return DEMO_MODELS[1] || DEMO_MODELS[0]
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
