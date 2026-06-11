import type { CellModel } from '../data/models';

export const GENERATED_MODEL_LIMIT = 48;

export function getGeneratedModelKey(model: CellModel) {
  if (model.custom) {
    return model.modelUrl || model.id || [model.name, model.source || model.subtitle, model.templateId || ''].join('|');
  }
  return model.modelUrl || model.id;
}

export function uniqueGeneratedModels(models: CellModel[], limit = GENERATED_MODEL_LIMIT) {
  const seen = new Set<string>();
  const unique: CellModel[] = [];
  for (const model of models) {
    const key = getGeneratedModelKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(model);
  }
  return unique.slice(0, limit);
}

export function upsertGeneratedModelStable(current: CellModel[], model: CellModel, limit = GENERATED_MODEL_LIMIT) {
  const key = getGeneratedModelKey(model);
  const index = current.findIndex((item) => getGeneratedModelKey(item) === key);
  if (index >= 0) {
    const next = current.slice();
    next[index] = model;
    return uniqueGeneratedModels(next, limit);
  }
  const next = uniqueGeneratedModels(current, limit);
  const normalizedLimit = normalizeGeneratedModelLimit(limit);
  if (next.length >= normalizedLimit) {
    return [...next.slice(0, normalizedLimit - 1), model];
  }
  return [...next, model];
}

export function mergeGeneratedModelsStable(current: CellModel[], incoming: CellModel[], limit = GENERATED_MODEL_LIMIT) {
  const existingKeys = new Set(current.map(getGeneratedModelKey));
  const existingIncoming = incoming.filter((model) => existingKeys.has(getGeneratedModelKey(model)));
  const newIncoming = incoming
    .filter((model) => !existingKeys.has(getGeneratedModelKey(model)))
    .sort((a, b) => getGeneratedModelTimestamp(a) - getGeneratedModelTimestamp(b));
  return [...existingIncoming, ...newIncoming].reduce((next, model) => upsertGeneratedModelStable(next, model, limit), current);
}

export function selectNewestGeneratedModel(models: CellModel[]) {
  if (!models.length) return null;
  return models.reduce((latest, model) => {
    return getGeneratedModelTimestamp(model) > getGeneratedModelTimestamp(latest) ? model : latest;
  }, models[0]);
}

export function compactGeneratedModelsForIndex(models: CellModel[]) {
  const fixedModels = models.filter((model) => !model.custom);
  const generatedGroups = new Map<string, CellModel[]>();

  for (const model of models) {
    if (!model.custom) continue;
    const key = getGeneratedModelIndexGroupKey(model);
    generatedGroups.set(key, [...(generatedGroups.get(key) || []), model]);
  }

  const compactGenerated = Array.from(generatedGroups.values())
    .map((group) => {
      const sorted = group.slice().sort((a, b) => getGeneratedModelTimestamp(b) - getGeneratedModelTimestamp(a));
      const latest = sorted[0];
      return {
        ...latest,
        indexGroupCount: sorted.length,
        indexSearchText: sorted
          .map((model) => [
            model.name,
            model.subtitle,
            model.category,
            model.description,
            model.source,
            model.generationStatus,
            model.templateId,
            model.modelUrl,
          ].filter(Boolean).join(' '))
          .join(' '),
      };
    })
    .sort((a, b) => getGeneratedModelTimestamp(b) - getGeneratedModelTimestamp(a));

  return [...fixedModels, ...compactGenerated];
}

export function resolveCompactGeneratedModelId(models: CellModel[], id: string) {
  const model = models.find((item) => item.id === id);
  if (!model?.custom) return id;

  const groupKey = getGeneratedModelIndexGroupKey(model);
  return compactGeneratedModelsForIndex(models).find((item) => item.custom && getGeneratedModelIndexGroupKey(item) === groupKey)?.id || id;
}

export function resolveLatestGeneratedModelIdForActive(models: CellModel[], id: string) {
  const model = models.find((item) => item.id === id);
  if (!model?.custom) return id;

  const groupKey = getGeneratedModelIndexGroupKey(model);
  const latest = models
    .filter((item) => item.custom && getGeneratedModelIndexGroupKey(item) === groupKey)
    .sort((a, b) => getGeneratedModelTimestamp(b) - getGeneratedModelTimestamp(a))[0];
  return latest?.id || id;
}

export function getGeneratedModelTimestamp(model: CellModel) {
  const text = `${model.id || ''} ${model.modelUrl || ''} ${model.imageUrl || ''}`;
  const match = text.match(/(?:generated-)?job-(\d{10,})/);
  if (!match) return 0;
  const timestamp = Number(match[1]);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeGeneratedModelLimit(limit: number) {
  const normalized = Math.floor(Number.isFinite(limit) ? limit : GENERATED_MODEL_LIMIT);
  return Math.max(1, normalized);
}

function getGeneratedModelIndexGroupKey(model: CellModel) {
  const templateKey = model.templateId || inferGeneratedModelTemplate(model);
  if (templateKey) return `template:${templateKey}`;
  const nameKey = model.name.replace(/^(AI\s*)?生成[:：]\s*/i, '').trim().toLowerCase();
  return `name:${nameKey || getGeneratedModelKey(model)}`;
}

function inferGeneratedModelTemplate(model: CellModel) {
  const text = `${model.id || ''} ${model.name || ''} ${model.subtitle || ''} ${model.description || ''} ${model.modelUrl || ''}`.toLowerCase();
  if (/mitochondrion|线粒体/.test(text)) return 'mitochondrion';
  if (/chloroplast|叶绿体/.test(text)) return 'chloroplast';
  if (/bacterium|细菌/.test(text)) return 'bacterium';
  if (/white-blood|白细胞/.test(text)) return 'white-blood-cell';
  if (/neuron|神经元/.test(text)) return 'neuron';
  if (/\bdna\b|双螺旋/.test(text)) return 'dna';
  if (/animal-cell|动物细胞|上皮/.test(text)) return 'animal-cell';
  if (/plant-cell|植物细胞/.test(text)) return 'plant-cell';
  return '';
}
