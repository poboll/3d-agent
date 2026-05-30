import { useEffect, useMemo, useRef, useState } from 'react';
import type { CellModel } from '../data/models';

interface Props {
  models: CellModel[];
  activeId: string;
  onSelect: (id: string) => void;
  onOpenIndex: () => void;
  guideOpen?: boolean;
  focusSignal?: number;
}

export function Sidebar({ models, activeId, onSelect, onOpenIndex, guideOpen = false, focusSignal = 0 }: Props) {
  const activeModel = models.find((model) => model.id === activeId) ?? models[0];
  const [imageOpen, setImageOpen] = useState(false);
  const [imageZoom, setImageZoom] = useState(1);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredModels = useMemo(() => {
    if (!normalizedQuery) return orderModelsForIndex(models, activeId);

    const matches = models
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
          model.features.map((feature) => `${feature.name} ${feature.detail}`).join(' '),
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

    return orderModelsForIndex(matches, activeId);
  }, [activeId, models, normalizedQuery]);

  useEffect(() => {
    if (!focusSignal) return;
    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus();
    }, 160);

    return () => window.clearTimeout(timer);
  }, [focusSignal]);

  const openImage = () => {
    setImageZoom(1);
    setImageOpen(true);
  };

  const focusIndexSearch = () => {
    onOpenIndex();
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  };

  return (
    <aside className="sidebar" aria-label="模型索引">
      <div className="sidebar-section official-section">
        <header className="sidebar-header">
          <span className="dot" />
          <span className="sidebar-label-main">标本索引</span>
          <span className="sidebar-label-sub">标本索引</span>
        </header>
        {activeModel && (
          <section className="specimen-summary" aria-label="当前标本介绍">
            <div className="specimen-media-stack">
              <button type="button" className="specimen-summary-image" onClick={openImage} aria-label={`放大查看${activeModel.name}标本图`}>
                <span className="specimen-summary-tag">{activeModel.category}</span>
                <img src={activeModel.imageUrl} alt={`${activeModel.name}标本图`} loading="lazy" />
              </button>
              <div className="specimen-location-note">
                <span>位置</span>
                <strong>{activeModel.location}</strong>
              </div>
            </div>
            <div className="specimen-summary-copy">
              <span>{activeModel.category} / {activeModel.visibleInLM === '是' ? '光镜可见' : activeModel.visibleInLM}</span>
              <strong>{activeModel.name}</strong>
              <p>{activeModel.description}</p>
            </div>
          </section>
        )}
        {activeModel && (
          <section className="specimen-learning" aria-label="教学信息">
            <article className="learning-card index-card" id="specimen-index-card" data-testid="specimen-index-card">
              <div className="index-toolbar">
                <button type="button" className="card-title-button" onClick={focusIndexSearch}>标本列表</button>
                <label className="specimen-search">
                  <span>搜索</span>
                  <input
                    ref={searchInputRef}
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="植物细胞 / 真核 / 叶绿体"
                    aria-label="搜索标本列表"
                    data-testid="specimen-search"
                  />
                </label>
              </div>
              <ul className="cell-list">
                {filteredModels.length > 0 ? (
                  filteredModels.map((m) => (
                    <CellItem
                      key={m.id}
                      model={m}
                      active={m.id === activeId}
                      onSelect={() => onSelect(m.id)}
                    />
                  ))
                ) : (
                  <li className="cell-empty">没有找到匹配的标本</li>
                )}
              </ul>
            </article>
            <article className="learning-card specimen-art-card">
              <span>观察字稿</span>
              <div className="art-card-body">
                <div className="art-card-grid">
                  <p className="art-display">{activeModel.name}</p>
                  <p className="art-subtitle">{activeModel.subtitle}</p>
                  <p className="art-caption">{activeModel.category} · {activeModel.visibleInLM === '是' ? '光镜可见' : activeModel.visibleInLM}</p>
                </div>
                <p className="art-quote">{activeModel.funFact}</p>
              </div>
            </article>
            <article className="learning-card specimen-habitat-card">
              <span>分布与生境</span>
              <p>{activeModel.whereItOccurs.text}</p>
              <em>{activeModel.whereItOccurs.habitat}</em>
            </article>
          </section>
        )}
      </div>
      {imageOpen && !guideOpen && activeModel && (
        <aside className="specimen-popover" role="dialog" aria-label="标本图预览">
          <button type="button" className="specimen-popover-close" onClick={() => setImageOpen(false)}>关闭</button>
          <span className="overlay-eyebrow">标本图 · {activeModel.name}</span>
          <div className="image-preview-frame">
              <img
                src={activeModel.imageUrl}
                alt={`${activeModel.name}标本图`}
                style={{ transform: `scale(${imageZoom})` }}
              />
          </div>
          <div className="image-preview-actions">
            <button type="button" onClick={() => setImageZoom((zoom) => Math.max(0.8, Number((zoom - 0.2).toFixed(1))))}>缩小</button>
            <span>{Math.round(imageZoom * 100)}%</span>
            <button type="button" onClick={() => setImageZoom(1)}>原始大小</button>
            <button type="button" onClick={() => setImageZoom((zoom) => Math.min(2.6, Number((zoom + 0.2).toFixed(1))))}>放大</button>
          </div>
        </aside>
      )}
    </aside>
  );
}

function CellItem({
  model,
  active,
  onSelect,
}: {
  model: CellModel;
  active: boolean;
  onSelect: () => void;
}) {
  const displayName = model.custom ? formatGeneratedModelName(model.name) : model.name;
  const statusLabel = model.custom ? 'AI 生成' : model.category;
  const sourceLabel = model.custom
    ? model.source || model.generationStatus || '本地生成结果'
    : model.subtitle;

  return (
    <li>
      <button
        type="button"
        className={`cell-item${active ? ' active' : ''}${model.custom ? ' custom' : ''}`}
        onClick={onSelect}
        style={{ '--accent': model.accent } as React.CSSProperties}
        data-testid="specimen-list-item"
      >
        {active && <span className="cell-current-mark">当前</span>}
        <div className="cell-thumb">
          <img src={model.imageUrl} alt={displayName} loading="lazy" />
        </div>
        <div className="cell-meta">
          <div className="cell-title-row">
            <div className="cell-name">{displayName}</div>
            <span className={`status-chip ${active ? 'ok' : 'idle'}`}>
              {active && <Check />}
              {statusLabel}
            </span>
          </div>
          <div className="cell-sub">{sourceLabel}</div>
        </div>
      </button>
    </li>
  );
}

function orderModelsForIndex(models: CellModel[], activeId: string) {
  return [...models].sort((a, b) => {
    if (a.id === activeId) return -1;
    if (b.id === activeId) return 1;
    if (a.custom && !b.custom) return -1;
    if (!a.custom && b.custom) return 1;
    return 0;
  });
}

function formatGeneratedModelName(name: string) {
  return name.replace(/^(AI\s*)?生成[:：]\s*/i, '').trim();
}

function Check() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}
