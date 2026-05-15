import type { CellModel } from '../data/models';

interface Props {
  models: CellModel[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function Sidebar({ models, activeId, onSelect }: Props) {
  return (
    <aside className="sidebar" aria-label="模型索引">
      <div className="sidebar-section official-section">
        <header className="sidebar-header">
          <span className="dot" />
          <span className="sidebar-label-main">SPECIMEN INDEX</span>
          <span className="sidebar-label-sub">标本索引</span>
        </header>
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
