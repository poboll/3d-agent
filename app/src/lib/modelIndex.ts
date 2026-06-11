import type { CellModel } from '../data/models';

export function filterModelsForIndex(models: CellModel[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return models.slice();

  return models
    .map((model, index) => {
      const fields = [
        model.name,
        model.subtitle,
        model.category,
        model.description,
        model.size,
        model.location,
        model.visibleInLM,
        model.source,
        model.generationStatus,
        model.templateId,
        model.indexSearchText,
        model.features.map((feature) => `${feature.name} ${feature.detail}`).join(' '),
        model.concepts?.map((concept) => `${concept.term} ${concept.level} ${concept.explanation} ${concept.visualHint}`).join(' '),
      ]
        .filter(Boolean)
        .map((field) => String(field).toLowerCase());
      const searchableText = fields.join(' ');

      if (!searchableText.includes(normalizedQuery)) {
        return null;
      }

      const [name = '', subtitle = '', category = '', description = ''] = fields;
      let rank = 40;
      if (name === normalizedQuery) rank = 0;
      else if (name.includes(normalizedQuery)) rank = 1;
      else if (subtitle.includes(normalizedQuery)) rank = 2;
      else if (category.includes(normalizedQuery)) rank = 3;
      else if (description.includes(normalizedQuery)) rank = 4;

      return { model, rank, index };
    })
    .filter((item): item is { model: CellModel; rank: number; index: number } => Boolean(item))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.model);
}
