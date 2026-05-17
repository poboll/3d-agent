import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_MODEL_ID, MODELS } from './data/models';
import { Sidebar } from './components/Sidebar';
import { ModelViewer } from './components/ModelViewer';
import { GenerationPanel } from './components/GenerationPanel';
import { MaAboutPanel } from './components/MaAboutPanel';
import type { CellModel } from './data/models';
import './app.css';

const GENERATED_MODELS_STORAGE_KEY = 'learning-cell-generated-models';

function readStoredGeneratedModels() {
  try {
    const stored = localStorage.getItem(GENERATED_MODELS_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as CellModel[];
    return Array.isArray(parsed) ? parsed.filter((model) => model?.id && model?.modelUrl).slice(0, 12) : [];
  } catch {
    localStorage.removeItem(GENERATED_MODELS_STORAGE_KEY);
    return [];
  }
}

function App() {
  const [activeId, setActiveId] = useState<string>(DEFAULT_MODEL_ID);
  const [generatedModels, setGeneratedModels] = useState<CellModel[]>(readStoredGeneratedModels);
  const [route, setRoute] = useState(() => (window.location.hash === '#about-ma' ? 'about' : 'workbench'));
  const allModels = useMemo(() => [...MODELS, ...generatedModels], [generatedModels]);
  const activeModel = useMemo(
    () => allModels.find((m) => m.id === activeId) ?? MODELS[0],
    [activeId, allModels]
  );

  useEffect(() => {
    const syncRoute = () => {
      setRoute(window.location.hash === '#about-ma' ? 'about' : 'workbench');
    };

    window.addEventListener('hashchange', syncRoute);
    return () => window.removeEventListener('hashchange', syncRoute);
  }, []);

  useEffect(() => {
    localStorage.setItem(GENERATED_MODELS_STORAGE_KEY, JSON.stringify(generatedModels.slice(0, 12)));
  }, [generatedModels]);

  const handleModelsLoaded = (models: CellModel[]) => {
    setGeneratedModels((current) => {
      const existingIds = new Set(current.map((model) => model.id));
      const merged = [...current];
      for (const model of models) {
        if (!existingIds.has(model.id)) merged.push(model);
      }
      return merged;
    });
  };

  const handleModelCreated = (model: CellModel) => {
    setGeneratedModels((current) => [model, ...current.filter((item) => item.id !== model.id)].slice(0, 12));
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="topbar-kicker" href="#workbench" aria-label="返回工作台">
          N° 07 · CELL PLANT FORGE · 2026
        </a>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">間</div>
          <span className="brand-rule" aria-hidden="true" />
          <div>
            <h1 className="brand-title">间 MA · 生物工作台</h1>
            <p className="brand-tagline">
              <span>MA CELL STUDIO</span>
              <span className="brand-sep">·</span>
              <span>Image confirmed before 3D</span>
            </p>
          </div>
        </div>
        <nav className="topbar-nav" aria-label="界面区域">
          <a href="#workbench">Workbench</a>
          <a href="#generate">Workflow</a>
          <a href="#specimens">Specimens</a>
          <a href="#about-ma">About</a>
          <span>Local API</span>
        </nav>
        <div className="hanko-mark" aria-hidden="true">間</div>
      </header>

      {route === 'about' ? (
        <main className="about-route">
          <MaAboutPanel />
        </main>
      ) : (
        <main className="layout" id="workbench">
          <aside className="control-rail" id="generate">
            <GenerationPanel
              generatedModels={generatedModels}
              onModelsLoaded={handleModelsLoaded}
              onModelCreated={handleModelCreated}
              onSelect={setActiveId}
            />
          </aside>

          <section
            className="stage"
            id="specimens"
            style={{ '--accent': activeModel.accent } as React.CSSProperties}
          >
            <ModelViewer key={activeModel.id} model={activeModel} />
          </section>

          <Sidebar models={allModels} activeId={activeId} onSelect={setActiveId} />
        </main>
      )}

      <footer className="footer">
        <span>© {new Date().getFullYear()} MA CELL STUDIO</span>
        <span>TEXT / IMAGE / 3D · TEACHING WORKBENCH</span>
        <span>LearningCell × 3DCellForge</span>
      </footer>
    </div>
  );
}

export default App;
