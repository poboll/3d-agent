import { useState } from 'react';
import type { CellModel } from '../data/models';

interface Props {
  models: CellModel[];
  activeId: string;
  onSelect: (id: string) => void;
  onOpenIndex: () => void;
}

export function Sidebar({ models, activeId, onSelect, onOpenIndex }: Props) {
  const activeModel = models.find((model) => model.id === activeId) ?? models[0];
  const [imageOpen, setImageOpen] = useState(false);
  const [imageZoom, setImageZoom] = useState(1);

  const openImage = () => {
    setImageZoom(1);
    setImageOpen(true);
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
            <button type="button" className="specimen-summary-image" onClick={openImage} aria-label={`放大查看${activeModel.name}标本图`}>
              <span className="specimen-summary-tag">{activeModel.category}</span>
              <img src={activeModel.imageUrl} alt={`${activeModel.name}标本图`} loading="lazy" />
            </button>
            <div className="specimen-summary-copy">
              <span>{activeModel.category}</span>
              <strong>{activeModel.name}</strong>
              <p>{activeModel.description}</p>
            </div>
            <dl className="specimen-summary-meta">
              <div>
                <dt>尺寸</dt>
                <dd>{activeModel.size}</dd>
              </div>
              <div>
                <dt>位置</dt>
                <dd>{activeModel.location}</dd>
              </div>
            </dl>
          </section>
        )}
        {activeModel && (
          <section className="specimen-learning" aria-label="教学信息">
            <article className="learning-card index-card" id="specimen-index-card">
              <button type="button" className="card-title-button" onClick={onOpenIndex}>标本列表 · 搜索</button>
              <ul className="cell-list">
                {models.map((m) => (
                  <CellItem
                    key={m.id}
                    model={m}
                    active={m.id === activeId}
                    onSelect={() => onSelect(m.id)}
                  />
                ))}
              </ul>
            </article>
            <article className="learning-card specimen-art-card">
              <span>观察字稿</span>
              <div className="art-card-grid">
                <p className="art-display">{activeModel.name}</p>
                <p className="art-subtitle">{activeModel.subtitle}</p>
                <p className="art-caption">{activeModel.category} · {activeModel.visibleInLM === '是' ? '光镜可见' : activeModel.visibleInLM}</p>
              </div>
              <p className="art-quote">{activeModel.funFact}</p>
            </article>
          </section>
        )}
      </div>
      {imageOpen && activeModel && (
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
  const statusLabel = model.custom ? '生成模型' : active ? '当前观察' : model.category;

  return (
    <li>
      <button
        type="button"
        className={`cell-item${active ? ' active' : ''}`}
        onClick={onSelect}
        style={{ '--accent': model.accent } as React.CSSProperties}
      >
        <span className="cell-item-index" aria-hidden="true">{model.custom ? 'GEN' : 'MA'}</span>
        <div className="cell-thumb">
          <img src={model.imageUrl} alt={model.name} loading="lazy" />
          {active && <span className="badge">当前</span>}
        </div>
        <div className="cell-meta">
          <div className="cell-name">{model.name}</div>
          <div className="cell-sub">{model.custom ? model.source ?? model.subtitle : model.subtitle}</div>
          <div className="cell-status">
            <span className={`status-chip ${active ? 'ok' : 'idle'}`}>
              {active && <Check />}
              {statusLabel}
            </span>
          </div>
        </div>
      </button>
    </li>
  );
}

function Check() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}
