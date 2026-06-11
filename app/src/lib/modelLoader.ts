import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const BASE = import.meta.env.BASE_URL;

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(`${BASE}draco/`.replace(/\/+/g, '/'));
// 优先使用 wasm；浏览器不支持时 three.js 会自动回退到 js 解码器
dracoLoader.setDecoderConfig({ type: 'wasm' });
dracoLoader.preload();

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

export type LoadStatus = 'idle' | 'downloading' | 'parsing' | 'done' | 'error';

export interface LoadEntry {
  url: string;
  status: LoadStatus;
  /** 0 ~ 1 */
  progress: number;
  buffer?: ArrayBuffer;
  gltf?: GLTF;
  error?: unknown;
  promise: Promise<GLTF>;
  listeners: Set<() => void>;
  lastUsedAt: number;
}

const cache = new Map<string, LoadEntry>();
const cacheListeners = new Set<() => void>();
const MAX_PARSED_MODELS = 3;
const loadControllers = new Map<string, AbortController>();

function notifyEntry(entry: LoadEntry) {
  entry.listeners.forEach((fn) => fn());
}

function notifyCache() {
  cacheListeners.forEach((fn) => fn());
}

export function subscribeCache(listener: () => void): () => void {
  cacheListeners.add(listener);
  return () => {
    cacheListeners.delete(listener);
  };
}

async function fetchWithProgress(
  url: string,
  expectedSize: number,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const response = await fetch(url, { cache: 'force-cache', signal });
  if (!response.ok) {
    throw new Error(`下载失败：${url} (${response.status})`);
  }
  const headerTotal = Number(response.headers.get('Content-Length')) || 0;
  const total = headerTotal > 0 ? headerTotal : expectedSize;

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onProgress(buffer.byteLength, total || buffer.byteLength);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, Math.max(total, loaded));
    }
  }

  const buffer = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer.buffer;
}

function parseGLTF(buffer: ArrayBuffer, base: string): Promise<GLTF> {
  return new Promise((resolve, reject) => {
    gltfLoader.parse(buffer, base, resolve, reject);
  });
}

export interface LoadOptions {
  fileSize?: number;
}

/**
 * 启动一次加载（如已加载过则直接复用缓存）。
 * 调用方需要显式触发，以便上层决定加载顺序和优先级。
 */
export function loadModel(url: string, options: LoadOptions): LoadEntry {
  const existing = cache.get(url);
  if (existing) {
    existing.lastUsedAt = Date.now();
    if (existing.status === 'idle') {
      startEntryLoad(existing, options);
    }
    return existing;
  }

  const entry: LoadEntry = {
    url,
    status: 'downloading',
    progress: 0,
    listeners: new Set(),
    lastUsedAt: Date.now(),
    promise: Promise.resolve() as unknown as Promise<GLTF>,
  };
  cache.set(url, entry);
  notifyCache();

  startEntryLoad(entry, options);
  return entry;
}

export function getLoadEntry(url: string): LoadEntry | undefined {
  const entry = cache.get(url);
  if (entry) entry.lastUsedAt = Date.now();
  return entry;
}

export function retryModel(url: string, options: LoadOptions): LoadEntry {
  const existing = cache.get(url);
  if (existing?.status === 'error') {
    startEntryLoad(existing, options);
    return existing;
  }
  return loadModel(url, options);
}

/** 后台静默预加载（不会抛错） */
export function preloadModel(url: string, options: LoadOptions): void {
  const entry = loadModel(url, options);
  entry.promise.catch(() => {
    /* 静默失败 */
  });
}

/** 克隆 GLTF.scene 一份以便每个 Canvas 实例使用 */
export function cloneScene(gltf: GLTF): THREE.Group {
  const cloned = gltf.scene.clone(true);
  cloned.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      brightenMeshMaterial(mesh.material);
    }
  });
  return cloned;
}

function brightenMeshMaterial(material: THREE.Material | THREE.Material[]) {
  const materials = Array.isArray(material) ? material : [material];
  for (const item of materials) {
    if (!item) continue;
    const standard = item as THREE.MeshStandardMaterial;
    const hasTexture = Boolean(standard.map);
    const hasVertexColors = Boolean(standard.vertexColors);
    if ('envMapIntensity' in standard) {
      standard.envMapIntensity = hasTexture
        ? Math.min(Math.max(standard.envMapIntensity || 0, 1.08), 1.32)
        : Math.max(standard.envMapIntensity || 0, 1.72);
    }
    if (standard.map) {
      standard.map.colorSpace = THREE.SRGBColorSpace;
      standard.map.needsUpdate = true;
    }
    if ('color' in standard && standard.color instanceof THREE.Color) {
      const hsl = { h: 0, s: 0, l: 0 };
      standard.color.getHSL(hsl);
      if ((hasTexture || hasVertexColors) && hsl.s < 0.08 && hsl.l > 0.86) {
        standard.color.setRGB(0.86, 0.84, 0.78);
      } else if (hsl.l < 0.42) {
        standard.color.offsetHSL(0, -0.025, Math.min(0.22, 0.42 - hsl.l + 0.055));
      }
    }
    if ('roughness' in standard && typeof standard.roughness === 'number') {
      standard.roughness = hasTexture
        ? Math.min(Math.max(standard.roughness, 0.34), 0.6)
        : Math.min(Math.max(standard.roughness, 0.42), 0.78);
    }
    if ('metalness' in standard && typeof standard.metalness === 'number') {
      standard.metalness = Math.min(standard.metalness, 0.08);
    }
    item.needsUpdate = true;
  }
}

function trimParsedCache(activeUrl: string) {
  const parsedEntries = [...cache.values()]
    .filter((entry) => entry.status === 'done' && entry.gltf && entry.url !== activeUrl)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

  while (parsedEntries.length >= MAX_PARSED_MODELS) {
    const entry = parsedEntries.shift();
    if (!entry) break;
    disposeGLTF(entry.gltf);
    cache.delete(entry.url);
    notifyEntry(entry);
  }
}

function startEntryLoad(entry: LoadEntry, options: LoadOptions) {
  loadControllers.get(entry.url)?.abort();
  const controller = new AbortController();
  loadControllers.set(entry.url, controller);
  entry.status = 'downloading';
  entry.progress = 0;
  entry.buffer = undefined;
  entry.gltf = undefined;
  entry.error = undefined;
  entry.lastUsedAt = Date.now();
  notifyEntry(entry);

  entry.promise = (async () => {
    try {
      const buffer = await fetchWithProgress(entry.url, options.fileSize ?? 0, (loaded, total) => {
        entry.status = 'downloading';
        entry.progress = Math.min(0.95, (loaded / Math.max(1, total)) * 0.95);
        notifyEntry(entry);
      }, controller.signal);
      entry.buffer = buffer;
      entry.status = 'parsing';
      entry.progress = 0.97;
      notifyEntry(entry);

      const gltf = await parseGLTF(buffer, '');
      entry.buffer = undefined;
      entry.gltf = gltf;
      entry.status = 'done';
      entry.progress = 1;
      trimParsedCache(entry.url);
      loadControllers.delete(entry.url);
      notifyEntry(entry);
      return gltf;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        entry.status = 'idle';
        entry.progress = 0;
        loadControllers.delete(entry.url);
        notifyEntry(entry);
        throw error;
      }
      entry.status = 'error';
      entry.error = error;
      loadControllers.delete(entry.url);
      notifyEntry(entry);
      throw error;
    }
  })();
  entry.promise.catch(() => {
    /* useModel exposes error state; avoid unhandled promise noise during rapid switches. */
  });
}

function disposeGLTF(gltf?: GLTF) {
  if (!gltf?.scene) return;
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  gltf.scene.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const materialList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materialList) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });

  geometries.forEach((geometry) => geometry.dispose());
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
}
