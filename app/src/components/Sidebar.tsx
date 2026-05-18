import type { CellModel } from '../data/models';

interface Props {
  models: CellModel[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function Sidebar({ models, activeId, onSelect }: Props) {
  const activeModel = models.find((model) => model.id === activeId) ?? models[0];

  return (
    <aside className="sidebar" aria-label="模型索引">
      <div className="sidebar-section official-section">
        <header className="sidebar-header">
          <span className="dot" />
          <span className="sidebar-label-main">SPECIMEN INDEX</span>
          <span className="sidebar-label-sub">标本索引</span>
        </header>
        {activeModel && (
          <section className="specimen-summary" aria-label="当前标本介绍">
            <div className="specimen-summary-image">
              <img src={activeModel.imageUrl} alt={`${activeModel.name}标本图`} loading="lazy" />
            </div>
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
            <article className="learning-card index-card">
              <span>INDEX / 标本</span>
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
              <span>OBSERVATION SCRIPT / 观察字稿</span>
              <div className="art-card-grid">
                <p className="art-display">{activeModel.name}</p>
                <p className="art-subtitle">{activeModel.subtitle}</p>
                <p className="art-caption">{activeModel.category} · {activeModel.visibleInLM === '是' ? 'Light microscope ready' : activeModel.visibleInLM}</p>
              </div>
              <p className="art-quote">{activeModel.funFact}</p>
            </article>
          </section>
        )}
      </div>
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
  return (
    <li>
      <button
        type="button"
        className={`cell-item${active ? ' active' : ''}`}
        onClick={onSelect}
        style={{ '--accent': model.accent } as React.CSSProperties}
      >
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
              {model.custom ? '生成' : active ? '查看中' : '标本'}
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
