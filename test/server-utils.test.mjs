import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getModelExtension, sanitizeModelId, validateModelBuffer } from '../server/model-store.mjs'
import { buildBioReadyPrompt, normalizeReferencePrompt, validateImageBuffer } from '../server/reference-store.mjs'
import { sanitizeFileName } from '../server/http-utils.mjs'
import { DEFAULT_IMAGE_PROVIDER } from '../server/config.mjs'
import { isAnalyticsEventAllowed } from '../server/analytics-store.mjs'
import {
  chooseTemplateForPrompt,
  createPromptTitle,
  estimateGenerationCost,
  getTemplateDisplayName,
  isRecoverableWorkflowJob,
  normalizeImageProvider,
  normalizePrompt,
  normalizeProvider,
  normalizeWorkflowImageProvider,
} from '../server/workflow-utils.mjs'

describe('LearningCell fusion API utilities', () => {
  it('sanitizes file and model names', () => {
    assert.equal(sanitizeFileName('../plant cell ✨.glb'), 'plant cell .glb')
    assert.equal(sanitizeModelId('local plant cell.glb'), 'local-plant-cell')
  })

  it('detects supported model extensions', () => {
    assert.equal(getModelExtension('cell.glb'), 'glb')
    assert.equal(getModelExtension('cell.gltf'), 'gltf')
    assert.throws(() => getModelExtension('cell.obj'), /GLB/)
  })

  it('validates GLB and GLTF buffers', () => {
    assert.doesNotThrow(() => validateModelBuffer(Buffer.concat([Buffer.from('glTF'), Buffer.alloc(28)]), 'glb'))
    assert.throws(() => validateModelBuffer(Buffer.concat([Buffer.from('nope'), Buffer.alloc(28)]), 'glb'), /GLB/)
    assert.doesNotThrow(() => validateModelBuffer(Buffer.from(JSON.stringify({ asset: { version: '2.0' } }).padEnd(40)), 'gltf'))
  })

  it('validates supported reference image signatures', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(40),
    ])
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40)])
    assert.doesNotThrow(() => validateImageBuffer(png, 'png'))
    assert.doesNotThrow(() => validateImageBuffer(jpeg, 'jpg'))
    assert.throws(() => validateImageBuffer(Buffer.concat([Buffer.from('not-image'), Buffer.alloc(40)]), 'png'), /PNG/)
  })

  it('normalizes workflow input and provider names', () => {
    assert.equal(normalizePrompt('  叶绿体   植物细胞 结构  '), '叶绿体 植物细胞 结构')
    assert.throws(() => normalizePrompt('细胞'), /更具体/)
    assert.equal(normalizeReferencePrompt('线粒体'), '线粒体')
    assert.throws(() => normalizeReferencePrompt('x'), /生物结构术语/)
    assert.equal(normalizeProvider('selfhost-triposg'), 'selfhost-triposg')
    assert.equal(normalizeProvider('local-demo'), 'local-demo')
    assert.equal(normalizeProvider(''), 'selfhost-triposg')
    assert.equal(normalizeImageProvider('openai'), 'openai')
    assert.equal(normalizeImageProvider('local-gateway'), 'local-gateway')
    assert.equal(normalizeImageProvider(''), DEFAULT_IMAGE_PROVIDER)
    assert.equal(normalizeWorkflowImageProvider('upload'), 'upload')
    assert.throws(() => normalizeProvider('unknown'), /provider/)
    assert.throws(() => normalizeImageProvider('unknown'), /图片生成/)
  })

  it('chooses sensible model templates from prompts', () => {
    assert.equal(chooseTemplateForPrompt('展示植物细胞、叶绿体和细胞壁'), 'plant-cell')
    assert.equal(chooseTemplateForPrompt('线粒体开放剖面'), 'mitochondrion')
    assert.equal(chooseTemplateForPrompt('叶绿体开放剖面 3D 教学模型，突出类囊体、基粒和双层膜'), 'chloroplast')
    assert.equal(chooseTemplateForPrompt('杆状细菌教学模型'), 'bacterium')
    assert.equal(chooseTemplateForPrompt('DNA 双螺旋和碱基对'), 'dna')
    assert.equal(chooseTemplateForPrompt('神经元轴突树突结构'), 'neuron')
    assert.equal(chooseTemplateForPrompt('白细胞吞噬病原体'), 'white-blood-cell')
    assert.equal(chooseTemplateForPrompt('上皮动物细胞结构'), 'animal-cell')
    assert.equal(chooseTemplateForPrompt('whatever', 'dna'), 'dna')
  })

  it('builds 3D-ready image prompts from biology terms', async () => {
    const result = await buildBioReadyPrompt('线粒体开放剖面教学模型', 'auto')
    assert.equal(result.term, '线粒体')
    assert.match(result.imagePrompt, /bean-shaped mitochondrion/)
    assert.match(result.imagePrompt, /three-quarter open cutaway/)
    assert.match(result.negativePrompt, /transparent jelly/)
  })

  it('builds customer-facing titles and cost estimates', () => {
    assert.equal(createPromptTitle('  复杂植物细胞三维模型，包含叶绿体和液泡  '), '复杂植物细胞三维模型包含叶绿体和...')
    assert.equal(getTemplateDisplayName('plant-cell'), '植物细胞')
    assert.equal(getTemplateDisplayName('mitochondrion'), '线粒体')
    assert.equal(getTemplateDisplayName('unknown'), '生物结构')
    assert.equal(estimateGenerationCost('local-demo'), 0)
    assert.equal(estimateGenerationCost('tencent-hunyuan') > 0, true)
  })

  it('accepts frontend workflow analytics used by the generation panel', () => {
    assert.equal(isAnalyticsEventAllowed('workflow_full_reference_ready'), true)
    assert.equal(isAnalyticsEventAllowed('workflow_job_prompt_reuse'), true)
    assert.equal(isAnalyticsEventAllowed('workflow_job_manual_sync'), true)
    assert.equal(isAnalyticsEventAllowed('unknown_workflow_event'), false)
  })

  it('detects recoverable workflow jobs without reviving stale or completed work', () => {
    const now = Date.parse('2026-05-23T04:00:00.000Z')
    const baseJob = {
      id: 'job-1',
      prompt: '线粒体开放剖面模型',
      provider: 'local-demo',
      status: 'processing',
      updatedAt: '2026-05-23T03:58:00.000Z',
    }

    assert.equal(isRecoverableWorkflowJob(baseJob, { now }), true)
    assert.equal(isRecoverableWorkflowJob({ ...baseJob, status: 'queued' }, { now }), true)
    assert.equal(isRecoverableWorkflowJob({ ...baseJob, status: 'completed' }, { now }), false)
    assert.equal(isRecoverableWorkflowJob({ ...baseJob, status: 'failed' }, { now }), false)
    assert.equal(
      isRecoverableWorkflowJob({ ...baseJob, updatedAt: '2026-05-22T23:00:00.000Z' }, { now }),
      false
    )
    assert.equal(isRecoverableWorkflowJob({ ...baseJob, prompt: '' }, { now }), false)
  })
})
