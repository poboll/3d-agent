import { readFile, writeFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'

const GLB_MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942
const COMPONENT_FLOAT = 5126
const ARRAY_BUFFER = 34962
const PNG_BASE64_2X2 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8Dwn4GBgYGJgYGBgQEAGyoBAtU3x+IAAAAASUVORK5CYII='
const MAX_EMBEDDED_TEXTURE_BYTES = 18 * 1024 * 1024

const TEMPLATE_COLORS = {
  'plant-cell': [0.45, 0.67, 0.36, 1],
  chloroplast: [0.30, 0.62, 0.25, 1],
  mitochondrion: [0.84, 0.43, 0.27, 1],
  'animal-cell': [0.86, 0.47, 0.58, 1],
  bacterium: [0.30, 0.62, 0.68, 1],
  neuron: [0.92, 0.62, 0.33, 1],
  dna: [0.45, 0.64, 0.84, 1],
  'white-blood-cell': [0.74, 0.55, 0.82, 1],
}

export async function colorizeGlbFile(inputPath, outputPath, options = {}) {
  const [input, textureImage] = await Promise.all([
    readFile(inputPath),
    options.textureImagePath ? readFile(options.textureImagePath).catch(() => null) : null,
  ])
  const output = colorizeGlbBuffer(input, {
    ...options,
    textureImage: options.textureImage || textureImage,
  })
  await writeFile(outputPath, output)
  return { bytes: output.length }
}

export function colorizeGlbBuffer(buffer, options = {}) {
  const { json, binChunk } = readGlb(buffer)
  const referenceColorProfile = options.color
    ? null
    : buildReferenceColorProfile(options.textureImage, options.textureMimeType)
  const baseColor = normalizeColor(options.color || referenceColorProfile?.baseColor || TEMPLATE_COLORS[options.template] || [0.52, 0.62, 0.42, 1])
  let materialIndex = ensureColorMaterial(json, {
    color: baseColor,
    materialName: options.materialName || `bio3d_${options.template || 'color'}_fallback_material`,
  })
  applyMaterialToMeshes(json, materialIndex)
  materialIndex = compactColorizedMaterials(json, materialIndex)
  const { binChunk: nextBinChunk, vertexColorPrimitives } = applyVertexColors(json, binChunk, {
    baseColor,
    template: options.template,
    referencePalette: referenceColorProfile?.palette,
    addTexcoords: options.texture !== false,
  })
  let finalBinChunk = nextBinChunk
  const textureInfo = options.texture === false
    ? { texturedPrimitives: 0 }
    : ensureFallbackTexture(json, nextBinChunk, {
        materialIndex,
        template: options.template,
        textureImage: options.textureImage,
        textureMimeType: options.textureMimeType,
      })
  if (textureInfo.binChunk) finalBinChunk = textureInfo.binChunk
  json.asset = {
    ...(json.asset || {}),
    generator: appendGenerator(
      json.asset?.generator,
      textureInfo.texturedPrimitives
      ? 'LearningCell Bio3D lightweight texture fallback'
      : referenceColorProfile
        ? 'LearningCell Bio3D reference-color fallback'
      : vertexColorPrimitives
      ? 'LearningCell Bio3D vertex color fallback'
      : 'LearningCell Bio3D color fallback'
    ),
  }
  return writeGlb(json, finalBinChunk)
}

function readGlb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) throw new Error('GLB 文件过小。')
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('GLB 文件头无效。')
  const version = buffer.readUInt32LE(4)
  if (version !== 2) throw new Error(`暂不支持 GLB v${version}。`)
  const length = buffer.readUInt32LE(8)
  if (length > buffer.length) throw new Error('GLB 长度字段无效。')

  let offset = 12
  let json = null
  let binChunk = Buffer.alloc(0)
  while (offset + 8 <= length) {
    const chunkLength = buffer.readUInt32LE(offset)
    const chunkType = buffer.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkLength
    if (chunkEnd > buffer.length) throw new Error('GLB chunk 长度无效。')
    const chunk = buffer.subarray(chunkStart, chunkEnd)
    if (chunkType === JSON_CHUNK) {
      json = JSON.parse(chunk.toString('utf8').replace(/[\u0000\s]+$/g, ''))
    } else if (chunkType === BIN_CHUNK) {
      binChunk = Buffer.from(chunk)
    }
    offset = chunkEnd
  }
  if (!json) throw new Error('GLB 缺少 JSON chunk。')
  return { json, binChunk }
}

function ensureColorMaterial(json, { color, materialName }) {
  const material = {
    name: materialName,
    alphaMode: 'OPAQUE',
    doubleSided: true,
    pbrMetallicRoughness: {
      baseColorFactor: color,
      roughnessFactor: 0.82,
      metallicFactor: 0,
    },
    emissiveFactor: [0, 0, 0],
  }
  if (!Array.isArray(json.materials)) json.materials = []
  json.materials.push(material)
  return json.materials.length - 1
}

function applyMaterialToMeshes(json, materialIndex) {
  const meshes = Array.isArray(json.meshes) ? json.meshes : []
  for (const mesh of meshes) {
    const primitives = Array.isArray(mesh.primitives) ? mesh.primitives : []
    for (const primitive of primitives) {
      primitive.material = materialIndex
    }
  }
}

function compactColorizedMaterials(json, materialIndex) {
  if (!Array.isArray(json.materials) || !json.materials[materialIndex]) return materialIndex
  if (json.materials.length <= 1) return materialIndex

  json.materials = [json.materials[materialIndex]]
  const meshes = Array.isArray(json.meshes) ? json.meshes : []
  for (const mesh of meshes) {
    const primitives = Array.isArray(mesh.primitives) ? mesh.primitives : []
    for (const primitive of primitives) {
      if (Number.isInteger(primitive?.material)) primitive.material = 0
    }
  }
  return 0
}

function applyVertexColors(json, binChunk, { baseColor, template, referencePalette, addTexcoords = true }) {
  const meshes = Array.isArray(json.meshes) ? json.meshes : []
  if (!meshes.length || !binChunk?.length) return { binChunk, vertexColorPrimitives: 0 }

  let workingBin = Buffer.from(binChunk)
  let vertexColorPrimitives = 0
  if (!Array.isArray(json.bufferViews)) json.bufferViews = []
  if (!Array.isArray(json.accessors)) json.accessors = []
  if (!Array.isArray(json.buffers)) json.buffers = [{ byteLength: workingBin.length }]
  if (!json.buffers[0]) json.buffers[0] = { byteLength: workingBin.length }

  for (const mesh of meshes) {
    const primitives = Array.isArray(mesh.primitives) ? mesh.primitives : []
    for (const primitive of primitives) {
      const positionAccessorIndex = primitive?.attributes?.POSITION
      const positions = readPositionAccessor(json, workingBin, positionAccessorIndex)
      if (!positions?.count) continue

      const colorBuffer = buildVertexColorBuffer(positions, { baseColor, template, referencePalette })
      const alignedBin = padChunk(workingBin, 0x00)
      const byteOffset = alignedBin.length
      workingBin = Buffer.concat([alignedBin, colorBuffer])
      const bufferViewIndex = json.bufferViews.length
      json.bufferViews.push({
        buffer: 0,
        byteOffset,
        byteLength: colorBuffer.length,
        target: ARRAY_BUFFER,
      })
      const accessorIndex = json.accessors.length
      json.accessors.push({
        bufferView: bufferViewIndex,
        byteOffset: 0,
        componentType: COMPONENT_FLOAT,
        count: positions.count,
        type: 'VEC4',
        min: [0, 0, 0, 1],
        max: [1, 1, 1, 1],
      })
      if (!primitive.attributes) primitive.attributes = {}
      primitive.attributes.COLOR_0 = accessorIndex
      if (addTexcoords && !Number.isInteger(primitive.attributes.TEXCOORD_0)) {
        const texcoordBuffer = buildTexcoordBuffer(positions)
        const texAlignedBin = padChunk(workingBin, 0x00)
        const texByteOffset = texAlignedBin.length
        workingBin = Buffer.concat([texAlignedBin, texcoordBuffer])
        const texBufferViewIndex = json.bufferViews.length
        json.bufferViews.push({
          buffer: 0,
          byteOffset: texByteOffset,
          byteLength: texcoordBuffer.length,
          target: ARRAY_BUFFER,
        })
        const texAccessorIndex = json.accessors.length
        json.accessors.push({
          bufferView: texBufferViewIndex,
          byteOffset: 0,
          componentType: COMPONENT_FLOAT,
          count: positions.count,
          type: 'VEC2',
          min: [0, 0],
          max: [1, 1],
        })
        primitive.attributes.TEXCOORD_0 = texAccessorIndex
      }
      vertexColorPrimitives += 1
    }
  }

  json.buffers[0].byteLength = workingBin.length
  return { binChunk: workingBin, vertexColorPrimitives }
}

function buildTexcoordBuffer(positions) {
  const buffer = Buffer.alloc(positions.count * 8)
  const spanX = Math.max(1e-6, positions.max[0] - positions.min[0])
  const spanY = Math.max(1e-6, positions.max[1] - positions.min[1])
  const spanZ = Math.max(1e-6, positions.max[2] - positions.min[2])
  for (let index = 0; index < positions.count; index += 1) {
    const vertex = positions.values[index]
    const u = clamp01((vertex[0] - positions.min[0]) / spanX)
    const v = clamp01(((vertex[1] - positions.min[1]) / spanY) * 0.72 + ((vertex[2] - positions.min[2]) / spanZ) * 0.28)
    const offset = index * 8
    buffer.writeFloatLE(u, offset)
    buffer.writeFloatLE(v, offset + 4)
  }
  return buffer
}

function ensureFallbackTexture(json, binChunk, { materialIndex, template, textureImage, textureMimeType }) {
  const texturedPrimitives = countTexturablePrimitives(json)
  if (!texturedPrimitives) return { binChunk, texturedPrimitives: 0 }
  if (!Array.isArray(json.images)) json.images = []
  if (!Array.isArray(json.textures)) json.textures = []
  if (!Array.isArray(json.samplers)) json.samplers = []
  if (!Array.isArray(json.bufferViews)) json.bufferViews = []
  if (!Array.isArray(json.buffers)) json.buffers = [{ byteLength: binChunk.length }]
  if (!json.buffers[0]) json.buffers[0] = { byteLength: binChunk.length }

  const embeddedTexture = normalizeEmbeddedTexture(textureImage, textureMimeType)
  const textureBytes = embeddedTexture?.bytes || tintPngBytes(Buffer.from(PNG_BASE64_2X2, 'base64'), template)
  const mimeType = embeddedTexture?.mimeType || 'image/png'
  const alignedBin = padChunk(binChunk, 0x00)
  const byteOffset = alignedBin.length
  const nextBinChunk = Buffer.concat([alignedBin, textureBytes])
  const bufferViewIndex = json.bufferViews.length
  json.bufferViews.push({
    buffer: 0,
    byteOffset,
    byteLength: textureBytes.length,
  })
  const imageIndex = json.images.length
  json.images.push({
    name: embeddedTexture
      ? `learningcell_${template || 'bio'}_reference_texture`
      : `learningcell_${template || 'bio'}_fallback_texture`,
    mimeType,
    bufferView: bufferViewIndex,
  })
  const samplerIndex = json.samplers.length
  json.samplers.push({
    magFilter: 9729,
    minFilter: 9729,
    wrapS: 10497,
    wrapT: 10497,
  })
  const textureIndex = json.textures.length
  json.textures.push({
    source: imageIndex,
    sampler: samplerIndex,
  })
  const material = json.materials?.[materialIndex]
  if (material?.pbrMetallicRoughness) {
    material.pbrMetallicRoughness.baseColorTexture = { index: textureIndex, texCoord: 0 }
  }
  json.buffers[0].byteLength = nextBinChunk.length
  return { binChunk: nextBinChunk, texturedPrimitives }
}

function normalizeEmbeddedTexture(textureImage, textureMimeType) {
  const bytes = Buffer.isBuffer(textureImage) ? textureImage : Buffer.from(textureImage || '')
  if (!bytes.length || bytes.length > MAX_EMBEDDED_TEXTURE_BYTES) return null

  const mimeType = normalizeTextureMimeType(textureMimeType, bytes)
  if (!mimeType) return null
  return { bytes, mimeType }
}

function normalizeTextureMimeType(mimeType, bytes) {
  const text = String(mimeType || '').toLowerCase().split(';')[0].trim()
  if ((text === 'image/png' || text === 'image/jpeg') && hasMatchingImageSignature(bytes, text)) return text
  if (hasMatchingImageSignature(bytes, 'image/png')) return 'image/png'
  if (hasMatchingImageSignature(bytes, 'image/jpeg')) return 'image/jpeg'
  return ''
}

function hasMatchingImageSignature(bytes, mimeType) {
  if (mimeType === 'image/png') {
    return bytes.length > 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  return false
}

function countTexturablePrimitives(json) {
  let count = 0
  const meshes = Array.isArray(json.meshes) ? json.meshes : []
  for (const mesh of meshes) {
    for (const primitive of Array.isArray(mesh.primitives) ? mesh.primitives : []) {
      if (Number.isInteger(primitive?.attributes?.TEXCOORD_0)) count += 1
    }
  }
  return count
}

function tintPngBytes(buffer, template) {
  // The embedded PNG is intentionally tiny. Template-specific color is carried by
  // vertex colors and material base factors so this stays dependency-free.
  void template
  return buffer
}

function readPositionAccessor(json, binChunk, accessorIndex) {
  if (!Number.isInteger(accessorIndex)) return null
  const accessor = json.accessors?.[accessorIndex]
  if (!accessor || accessor.componentType !== COMPONENT_FLOAT || accessor.type !== 'VEC3') return null
  const bufferView = json.bufferViews?.[accessor.bufferView]
  if (!bufferView || bufferView.buffer !== 0) return null

  const count = Number(accessor.count || 0)
  if (!count) return { count: 0, values: [], min: [0, 0, 0], max: [0, 0, 0] }
  const byteStride = Number(bufferView.byteStride || 12)
  if (byteStride < 12) return null
  const baseOffset = Number(bufferView.byteOffset || 0) + Number(accessor.byteOffset || 0)
  const values = new Array(count)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < count; index += 1) {
    const offset = baseOffset + index * byteStride
    if (offset + 12 > binChunk.length) return null
    const vertex = [
      binChunk.readFloatLE(offset),
      binChunk.readFloatLE(offset + 4),
      binChunk.readFloatLE(offset + 8),
    ]
    values[index] = vertex
    for (let axis = 0; axis < 3; axis += 1) {
      if (vertex[axis] < min[axis]) min[axis] = vertex[axis]
      if (vertex[axis] > max[axis]) max[axis] = vertex[axis]
    }
  }
  return { count, values, min, max }
}

function buildVertexColorBuffer(positions, { baseColor, template, referencePalette }) {
  const palette = buildTemplatePalette(baseColor, template, referencePalette)
  const buffer = Buffer.alloc(positions.count * 16)
  const span = positions.max.map((max, axis) => Math.max(1e-6, max - positions.min[axis]))
  for (let index = 0; index < positions.count; index += 1) {
    const vertex = positions.values[index]
    const nx = clamp01((vertex[0] - positions.min[0]) / span[0])
    const ny = clamp01((vertex[1] - positions.min[1]) / span[1])
    const nz = clamp01((vertex[2] - positions.min[2]) / span[2])
    const radial = Math.sqrt((nx - 0.5) ** 2 + (nz - 0.5) ** 2) / Math.SQRT1_2
    const band = Math.min(palette.length - 1, Math.floor(clamp01((ny * 0.55 + radial * 0.3 + nx * 0.15)) * palette.length))
    const light = 0.84 + ny * 0.26 + (1 - radial) * 0.14
    const color = mixColors(palette[band], palette[(band + 1) % palette.length], clamp01(nz * 0.45 + ny * 0.25))
      .map((value, channel) => channel === 3 ? value : clamp01(value * light))
    const offset = index * 16
    buffer.writeFloatLE(color[0], offset)
    buffer.writeFloatLE(color[1], offset + 4)
    buffer.writeFloatLE(color[2], offset + 8)
    buffer.writeFloatLE(color[3] ?? 1, offset + 12)
  }
  return buffer
}

function buildTemplatePalette(baseColor, template, referencePalette) {
  if (Array.isArray(referencePalette) && referencePalette.length >= 2) {
    const cleanPalette = referencePalette.map(normalizeColor).filter((color) => color.some((value, index) => index < 3 && value > 0.02))
    if (cleanPalette.length >= 2) {
      return [
        cleanPalette[0],
        cleanPalette[1],
        cleanPalette[2] || mixColors(cleanPalette[0], [0.96, 0.86, 0.42, 1], 0.28),
        mixColors(cleanPalette[0], [0.18, 0.22, 0.26, 1], 0.22),
      ]
    }
  }

  const accent = {
    chloroplast: [[0.18, 0.46, 0.22, 1], [0.55, 0.78, 0.32, 1], [0.90, 0.78, 0.28, 1]],
    mitochondrion: [[0.74, 0.24, 0.18, 1], [0.95, 0.54, 0.28, 1], [0.45, 0.22, 0.36, 1]],
    'plant-cell': [[0.30, 0.58, 0.28, 1], [0.74, 0.82, 0.38, 1], [0.38, 0.66, 0.58, 1]],
    'animal-cell': [[0.78, 0.34, 0.52, 1], [0.94, 0.64, 0.72, 1], [0.58, 0.42, 0.72, 1]],
    bacterium: [[0.24, 0.56, 0.62, 1], [0.44, 0.76, 0.58, 1], [0.90, 0.72, 0.32, 1]],
    neuron: [[0.82, 0.48, 0.26, 1], [0.98, 0.74, 0.34, 1], [0.52, 0.38, 0.70, 1]],
    dna: [[0.34, 0.52, 0.82, 1], [0.72, 0.44, 0.78, 1], [0.88, 0.70, 0.35, 1]],
    'white-blood-cell': [[0.66, 0.46, 0.78, 1], [0.90, 0.68, 0.84, 1], [0.54, 0.70, 0.86, 1]],
  }[template]
  return accent || [
    baseColor,
    mixColors(baseColor, [0.96, 0.82, 0.30, 1], 0.42),
    mixColors(baseColor, [0.24, 0.58, 0.78, 1], 0.35),
  ]
}

function buildReferenceColorProfile(textureImage, textureMimeType) {
  const bytes = Buffer.isBuffer(textureImage) ? textureImage : Buffer.from(textureImage || '')
  if (!bytes.length || bytes.length > MAX_EMBEDDED_TEXTURE_BYTES) return null
  if (normalizeTextureMimeType(textureMimeType, bytes) !== 'image/png') return null

  try {
    const pixels = readPngPixels(bytes)
    const palette = extractProminentColors(pixels)
    if (palette.length < 2) return null
    return {
      baseColor: averagePalette(palette.slice(0, 3)),
      palette,
    }
  } catch {
    return null
  }
}

function readPngPixels(bytes) {
  if (!hasMatchingImageSignature(bytes, 'image/png')) return []
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = -1
  let interlace = 0
  const idatChunks = []
  const palette = []

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const start = offset + 8
    const end = start + length
    if (end + 4 > bytes.length) break
    const data = bytes.subarray(start, end)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') {
      for (let index = 0; index + 2 < data.length; index += 3) {
        palette.push([data[index], data[index + 1], data[index + 2], 255])
      }
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }

    offset = end + 4
  }

  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !idatChunks.length) return []
  const channels = getPngChannels(colorType)
  if (!channels) return []
  const rowStride = width * channels
  const inflated = inflateSync(Buffer.concat(idatChunks))
  if (inflated.length < height * (rowStride + 1)) return []

  const pixels = []
  let previousRow = Buffer.alloc(rowStride)
  let cursor = 0
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[cursor]
    cursor += 1
    const scanline = Buffer.from(inflated.subarray(cursor, cursor + rowStride))
    cursor += rowStride
    const reconstructed = unfilterPngScanline(scanline, previousRow, channels, filter)
    for (let x = 0; x < width; x += 1) {
      const base = x * channels
      if (colorType === 0) {
        const gray = reconstructed[base]
        pixels.push([gray, gray, gray, 255])
      } else if (colorType === 2) {
        pixels.push([reconstructed[base], reconstructed[base + 1], reconstructed[base + 2], 255])
      } else if (colorType === 3) {
        const picked = palette[reconstructed[base]]
        if (picked) pixels.push(picked)
      } else if (colorType === 4) {
        const gray = reconstructed[base]
        pixels.push([gray, gray, gray, reconstructed[base + 1]])
      } else if (colorType === 6) {
        pixels.push([reconstructed[base], reconstructed[base + 1], reconstructed[base + 2], reconstructed[base + 3]])
      }
    }
    previousRow = reconstructed
  }
  return pixels
}

function getPngChannels(colorType) {
  if (colorType === 0) return 1
  if (colorType === 2) return 3
  if (colorType === 3) return 1
  if (colorType === 4) return 2
  if (colorType === 6) return 4
  return 0
}

function unfilterPngScanline(scanline, previousRow, channels, filter) {
  const row = Buffer.from(scanline)
  for (let index = 0; index < row.length; index += 1) {
    const left = index >= channels ? row[index - channels] : 0
    const up = previousRow[index] || 0
    const upLeft = index >= channels ? previousRow[index - channels] || 0 : 0
    if (filter === 1) {
      row[index] = (row[index] + left) & 0xff
    } else if (filter === 2) {
      row[index] = (row[index] + up) & 0xff
    } else if (filter === 3) {
      row[index] = (row[index] + Math.floor((left + up) / 2)) & 0xff
    } else if (filter === 4) {
      row[index] = (row[index] + paethPredictor(left, up, upLeft)) & 0xff
    } else if (filter !== 0) {
      throw new Error(`Unsupported PNG filter ${filter}.`)
    }
  }
  return row
}

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const upLeftDistance = Math.abs(estimate - upLeft)
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left
  if (upDistance <= upLeftDistance) return up
  return upLeft
}

function extractProminentColors(pixels) {
  const buckets = new Map()
  for (const pixel of pixels) {
    const alpha = (pixel[3] ?? 255) / 255
    if (alpha < 0.18) continue
    const rgb = pixel.slice(0, 3).map((value) => clamp01((Number(value) || 0) / 255))
    const avg = (rgb[0] + rgb[1] + rgb[2]) / 3
    const max = Math.max(...rgb)
    const min = Math.min(...rgb)
    const spread = max - min
    const saturation = max > 1e-6 ? spread / max : 0
    if (avg > 0.93 && saturation < 0.16) continue
    if (avg < 0.035 && saturation < 0.2) continue

    const key = rgb.map((value) => Math.round(value * 15)).join(',')
    const bucket = buckets.get(key) || { count: 0, color: [0, 0, 0, 1], score: 0, saturation: 0, brightness: 0 }
    bucket.count += 1
    for (let channel = 0; channel < 3; channel += 1) {
      bucket.color[channel] += rgb[channel]
    }
    bucket.saturation += saturation
    bucket.brightness += avg
    bucket.score += alpha
    buckets.set(key, bucket)
  }

  const scored = [...buckets.values()]
    .map((bucket) => ({
      score: scoreColorBucket(bucket),
      saturation: bucket.saturation / bucket.count,
      brightness: bucket.brightness / bucket.count,
      color: [
        clamp01(bucket.color[0] / bucket.count),
        clamp01(bucket.color[1] / bucket.count),
        clamp01(bucket.color[2] / bucket.count),
        1,
      ],
    }))
  const hasSubjectColor = scored.some((bucket) => bucket.saturation >= 0.24)
  return scored
    .filter((bucket) => !hasSubjectColor || bucket.saturation >= 0.16 || bucket.brightness < 0.58)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((bucket) => bucket.color)
}

function scoreColorBucket(bucket) {
  const count = Math.max(1, bucket.count)
  const saturation = bucket.saturation / count
  const brightness = bucket.brightness / count
  let score = Math.sqrt(bucket.score) * (0.12 + saturation ** 2 * 6 + saturation * 0.8)
  if (brightness > 0.72 && saturation < 0.24) score *= 0.12
  if (brightness > 0.84 && saturation < 0.34) score *= 0.32
  if (saturation < 0.10) score *= 0.08
  return score
}

function averagePalette(palette) {
  const colors = palette.filter(Boolean)
  if (!colors.length) return null
  const total = colors.reduce((sum, color) => {
    for (let channel = 0; channel < 3; channel += 1) sum[channel] += Number(color[channel] || 0)
    return sum
  }, [0, 0, 0])
  return [
    clamp01(total[0] / colors.length),
    clamp01(total[1] / colors.length),
    clamp01(total[2] / colors.length),
    1,
  ]
}

function mixColors(left, right, amount) {
  const next = []
  const t = clamp01(amount)
  for (let index = 0; index < 4; index += 1) {
    const a = Number(left[index] ?? (index === 3 ? 1 : 0))
    const b = Number(right[index] ?? (index === 3 ? 1 : 0))
    next[index] = clamp01(a + (b - a) * t)
  }
  return next
}

function writeGlb(json, binChunk) {
  const jsonBuffer = padChunk(Buffer.from(JSON.stringify(json), 'utf8'), 0x20)
  const binaryBuffer = binChunk?.length ? padChunk(Buffer.from(binChunk), 0x00) : null
  const totalLength = 12 + 8 + jsonBuffer.length + (binaryBuffer ? 8 + binaryBuffer.length : 0)
  const output = Buffer.alloc(totalLength)
  output.writeUInt32LE(GLB_MAGIC, 0)
  output.writeUInt32LE(2, 4)
  output.writeUInt32LE(totalLength, 8)
  output.writeUInt32LE(jsonBuffer.length, 12)
  output.writeUInt32LE(JSON_CHUNK, 16)
  jsonBuffer.copy(output, 20)
  if (binaryBuffer) {
    const offset = 20 + jsonBuffer.length
    output.writeUInt32LE(binaryBuffer.length, offset)
    output.writeUInt32LE(BIN_CHUNK, offset + 4)
    binaryBuffer.copy(output, offset + 8)
  }
  return output
}

function padChunk(buffer, padByte) {
  const padding = (4 - (buffer.length % 4)) % 4
  if (!padding) return buffer
  return Buffer.concat([buffer, Buffer.alloc(padding, padByte)])
}

function normalizeColor(color) {
  const next = Array.isArray(color) ? color.map(Number) : []
  if (next.length < 3 || next.some((item) => !Number.isFinite(item))) return [0.52, 0.62, 0.42, 1]
  return [
    clamp01(next[0]),
    clamp01(next[1]),
    clamp01(next[2]),
    clamp01(next.length >= 4 ? next[3] : 1),
  ]
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value))
}

function appendGenerator(current, addition) {
  const text = String(current || '').trim()
  return text ? `${text}; ${addition}` : addition
}
