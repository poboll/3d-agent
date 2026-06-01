import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  CELLFORGE_MODEL_DIR,
  DEFAULT_IMAGE_PROVIDER,
  DEMO_MODELS,
  LOCAL_MODEL_DIR,
  MOCK_WORKFLOW_STEP_DELAY,
  TENCENT_HUNYUAN_CONFIGURED,
} from './config.mjs'
import { sanitizeModelId } from './model-store.mjs'
import { getTemplateDisplayName } from './workflow-utils.mjs'
import { updateWorkflowJob } from './job-store.mjs'
import { generateComfyUiModel, resumeComfyUiModel } from './comfyui-provider.mjs'
import { createReferenceImage } from './reference-store.mjs'

const inMemoryJobs = new Set()

export function startWorkflowJob(job) {
  if (inMemoryJobs.has(job.id)) return
  inMemoryJobs.add(job.id)

  void executeWorkflowJob(job).catch((error) => {
    return updateWorkflowJob(
      job.id,
      {
        status: 'failed',
        progress: 100,
        stage: '生成任务失败。',
        error: error.message || '本地生成工作流执行失败。',
      },
      'failed'
    )
  }).finally(() => inMemoryJobs.delete(job.id))
}

export function startFullTextTo3dWorkflow(job) {
  if (inMemoryJobs.has(job.id)) return
  inMemoryJobs.add(job.id)

  void runFullTextTo3dWorkflow(job).catch((error) => {
    return updateWorkflowJob(
      job.id,
      {
        status: 'failed',
        progress: 100,
        stage: '完整生成链路失败。',
        error: error.message || '参考图生成或三维建模失败。',
      },
      'full-workflow-failed'
    )
  }).finally(() => inMemoryJobs.delete(job.id))
}

export async function resumeWorkflowJob(job) {
  if (!job || job.status === 'completed' || job.status === 'failed') return { resumed: false, reason: 'not-recoverable' }
  if (inMemoryJobs.has(job.id)) return { resumed: false, reason: 'already-running' }

  if (job.provider === 'selfhost-triposg' && job.providerJobId) {
    inMemoryJobs.add(job.id)
    void runResumedSelfHostedWorkflow(job)
      .catch((error) => {
        return updateWorkflowJob(
          job.id,
          {
            status: 'failed',
            progress: 100,
            stage: '续接本地三维任务失败。',
            error: error.message || '无法根据 ComfyUI prompt_id 续接任务。',
          },
          'resume-selfhost-failed'
        )
      })
      .finally(() => inMemoryJobs.delete(job.id))
    return { resumed: true, reason: 'selfhost-prompt-id' }
  }

  if (job.workflowMode === 'full-text-to-3d' && !job.referenceId) {
    startFullTextTo3dWorkflow(job)
    return { resumed: true, reason: 'full-text-to-3d' }
  }

  if (job.referenceId) {
    startWorkflowJob(job)
    return { resumed: true, reason: 'image-to-3d' }
  }

  await updateWorkflowJob(
    job.id,
    {
      status: 'failed',
      progress: 100,
      stage: '任务恢复失败：没有可复用的参考图，请重新生成参考图后再提交建模。',
      error: '缺少 referenceId，无法恢复图生 3D 任务。',
    },
    'resume-missing-reference'
  )
  return { resumed: false, reason: 'missing-reference' }
}

async function runFullTextTo3dWorkflow(job) {
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 8,
      stage: '正在将生物结构描述打磨成 3D-ready 单图 prompt。',
    },
    'full-workflow-prompt-started'
  )

  const reference = await createReferenceImage({
    prompt: job.prompt,
    template: job.template,
    provider: job.imageProvider || DEFAULT_IMAGE_PROVIDER,
    imageProfile: job.imageProfile,
    imageSize: job.imageSize,
    imageQuality: job.imageQuality,
    onProgress: async ({ progress, stage, eventName, patch = {} }) => {
      await updateWorkflowJob(
        job.id,
        {
          status: 'processing',
          progress: Math.max(job.progress || 0, progress),
          stage,
          ...patch,
        },
        `full-workflow-${eventName}`
      )
    },
  })

  const nextJob = await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 24,
      stage: '参考图已生成并自动接收，正在接续图生 3D 建模。',
      reference,
      referenceId: reference.id,
      referenceImageUrl: reference.imageUrl,
      imageProfile: reference.imageProfile || job.imageProfile,
      imageSize: reference.imageSize || job.imageSize,
      imageQuality: reference.imageQuality || job.imageQuality,
    },
    'full-workflow-reference-ready'
  )

  await executeWorkflowJob(nextJob)
}

async function executeWorkflowJob(job) {
  if (job.provider === 'tencent-hunyuan' && !TENCENT_HUNYUAN_CONFIGURED) {
    await updateWorkflowJob(
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
  await runner(job)
}

async function runSelfHostedWorkflow(job) {
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: Math.max(job.progress || 0, 28),
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

async function runResumedSelfHostedWorkflow(job) {
  const result = await resumeComfyUiModel(job, async ({ progress, stage, eventName, patch = {} }) => {
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
      stage: '本地图生 3D 已续接完成，模型已写入缓存并加入标本索引。',
      result,
    },
    'resume-selfhost-completed'
  )
}

async function runLocalDemoWorkflow(job) {
  await delay(MOCK_WORKFLOW_STEP_DELAY)
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: Math.max(job.progress || 0, 32),
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
  const sourcePath = await resolveDemoSourcePath(job.template, demoModel)
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
        accent: accentForTemplate(job.template),
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

function pickDemoModel(template) {
  if (template === 'plant-cell' || template === 'chloroplast') return DEMO_MODELS[0]
  return DEMO_MODELS[1] || DEMO_MODELS[0]
}

async function resolveDemoSourcePath(template, demoModel) {
  if (template === 'chloroplast' || template === 'plant-cell') {
    return path.join(CELLFORGE_MODEL_DIR, DEMO_MODELS[0].fileName)
  }
  const cachedTemplateModel = await findLatestCachedTemplateModel(template)
  if (cachedTemplateModel) return cachedTemplateModel
  return path.join(CELLFORGE_MODEL_DIR, demoModel.fileName)
}

async function findLatestCachedTemplateModel(template) {
  if (!template || template === 'plant-cell' || template === 'animal-cell') return ''

  try {
    const files = await readdir(LOCAL_MODEL_DIR, { withFileTypes: true })
    const candidates = []
    for (const file of files) {
      if (!file.isFile()) continue
      if (!file.name.endsWith(`-${template}.glb`)) continue
      if (!file.name.startsWith('generated-job-')) continue
      const localPath = path.join(LOCAL_MODEL_DIR, file.name)
      const info = await stat(localPath)
      candidates.push({ localPath, mtimeMs: info.mtimeMs })
    }
    return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.localPath || ''
  } catch {
    return ''
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
