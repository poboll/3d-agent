export const HEAVY_MODEL_BYTES = 35 * 1024 * 1024;

export function formatModelBytes(bytes?: number) {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '大小待测';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

export function isHeavyModel(bytes?: number) {
  return Boolean(bytes && Number.isFinite(bytes) && bytes >= HEAVY_MODEL_BYTES);
}

export function getModelLoadHint(bytes?: number) {
  if (isHeavyModel(bytes)) {
    return '重模型 · 已启用轻量渲染并保留光影';
  }
  if (bytes && bytes > 0) return '轻量模型 · 可快速预览';
  return '模型大小待测 · 正在读取缓存';
}

export function getModelLoadDetail(bytes?: number) {
  if (isHeavyModel(bytes)) {
    return '首次解析会更久，加载完成前建议先停留在当前标本；舞台会降低像素密度与环境贴图分辨率，但保留阴影、环境贴图和主光。';
  }
  if (bytes && bytes > 0) {
    return '模型体积较小，解析完成后即可拖拽观察。';
  }
  return '正在读取本地缓存信息，完成后会自动进入 3D 舞台。';
}
