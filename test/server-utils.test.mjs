import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getModelExtension, sanitizeModelId, validateModelBuffer } from '../server/model-store.mjs'
import { sanitizeFileName } from '../server/http-utils.mjs'

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
})
