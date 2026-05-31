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
    return '重模型 · 建议加载完成后再切换标本';
  }
  if (bytes && bytes > 0) return '轻量模型 · 可快速预览';
  return '模型大小待测 · 正在读取缓存';
}
