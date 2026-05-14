import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getModelExtension, sanitizeModelId, validateModelBuffer } from '../server/model-store.mjs'
import { sanitizeFileName } from '../server/http-utils.mjs'
import {
  chooseTemplateForPrompt,
  createPromptTitle,
  estimateGenerationCost,
  getTemplateDisplayName,
  normalizePrompt,
  normalizeProvider,
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

  it('normalizes workflow input and provider names', () => {
    assert.equal(normalizePrompt('  叶绿体   植物细胞 结构  '), '叶绿体 植物细胞 结构')
    assert.throws(() => normalizePrompt('细胞'), /更具体/)
    assert.equal(normalizeProvider('local-demo'), 'local-demo')
    assert.equal(normalizeProvider(''), 'local-demo')
    assert.throws(() => normalizeProvider('unknown'), /provider/)
  })

  it('chooses sensible model templates from prompts', () => {
    assert.equal(chooseTemplateForPrompt('展示植物细胞、叶绿体和细胞壁'), 'plant-cell')
    assert.equal(chooseTemplateForPrompt('DNA 双螺旋和碱基对'), 'dna')
    assert.equal(chooseTemplateForPrompt('神经元轴突树突结构'), 'neuron')
    assert.equal(chooseTemplateForPrompt('白细胞吞噬病原体'), 'white-blood-cell')
    assert.equal(chooseTemplateForPrompt('上皮动物细胞结构'), 'animal-cell')
    assert.equal(chooseTemplateForPrompt('whatever', 'dna'), 'dna')
  })

  it('builds customer-facing titles and cost estimates', () => {
    assert.equal(createPromptTitle('  复杂植物细胞三维模型，包含叶绿体和液泡  '), '复杂植物细胞三维模型包含叶绿体和...')
    assert.equal(getTemplateDisplayName('plant-cell'), '植物细胞')
    assert.equal(getTemplateDisplayName('unknown'), '生物结构')
    assert.equal(estimateGenerationCost('local-demo'), 0)
    assert.equal(estimateGenerationCost('tencent-hunyuan') > 0, true)
  })
})
