import type { CellModel } from '../data/models';

interface Props {
  model: CellModel;
}

export function InfoPanel({ model }: Props) {
  return (
    <aside className="info-panel" style={{ '--accent': model.accent } as React.CSSProperties}>
      <section className="info-card hero-card">
        <header>
          <span className="card-eyebrow">{model.custom ? '§ 04 — GENERATED SPECIMEN' : '§ 04 — TEACHING NOTE'}</span>
          <h2>{model.name}</h2>
          <p className="info-tagline">{model.subtitle}</p>
        </header>
        {model.custom && (
          <div className="generated-note">
            <span>{model.source ?? 'Generated'}</span>
            <p>{model.generationStatus ?? '已加入本地展示流程'}</p>
          </div>
        )}
        <dl className="info-grid">
          <div>
            <dt>类别</dt>
            <dd>{model.category}</dd>
          </div>
          <div>
            <dt>尺寸</dt>
            <dd>{model.size}</dd>
          </div>
          <div>
            <dt>所在部位</dt>
            <dd>{model.location}</dd>
          </div>
          <div>
            <dt>光镜可见</dt>
            <dd>
              <span className={`pill ${model.visibleInLM.startsWith('是') ? 'on' : 'off'}`}>
                {model.visibleInLM}
              </span>
            </dd>
          </div>
        </dl>
      </section>

      <section className="info-card">
        <span className="card-eyebrow">CLASSROOM / 教学提示</span>
        <p className="info-description">{model.description}</p>
      </section>

      <section className="info-card">
        <span className="card-eyebrow">STRUCTURE / 观察顺序</span>
        <ul className="feature-list">
          {model.features.slice(0, 5).map((f, index) => (
            <li key={f.name}>
              <span className="feature-dot">{index + 1}</span>
              <div>
                <div className="feature-name">{f.name}</div>
                <div className="feature-detail">{f.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="info-card fun-card">
        <span className="card-eyebrow">ASK / 课堂提问</span>
        <p className="fun-text">{model.funFact}</p>
      </section>

      <section className="info-card occur-card">
        <span className="card-eyebrow">CONTEXT / 分布与生境</span>
        <p>{model.whereItOccurs.text}</p>
        <div className="habitat">{model.whereItOccurs.habitat}</div>
      </section>
    </aside>
  );
}
