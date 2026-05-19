import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_MODEL_ID, MODELS } from './data/models';
import { Sidebar } from './components/Sidebar';
import { ModelViewer } from './components/ModelViewer';
import { GenerationPanel } from './components/GenerationPanel';
import { MaAboutPanel } from './components/MaAboutPanel';
import type { CellModel } from './data/models';
import './app.css';

const GENERATED_MODELS_STORAGE_KEY = 'learning-cell-generated-models';
const GUIDE_STORAGE_KEY = 'ma-cell-workflow-guide-seen';

const GUIDE_STEPS = [
  {
    title: '第一步：写描述或上传图片',
    body: '从左侧生成工坊开始，输入生物结构描述，也可以直接上传一张参考图。',
  },
  {
    title: '第二步：确认参考图',
    body: '文生图先产出初版图片，用户可以重试、接收或退回，确认后才进入 3D 建模。',
  },
  {
    title: '第三步：图升 3D 建模',
    body: '确认图片后再调用本地演示或混元 3D 服务，生成结果会下载并缓存到模型索引。',
  },
  {
    title: '第四步：舞台观察模型',
    body: '中间舞台用于旋转、缩放和复位视角，右侧观察焦点辅助课堂讲解。',
  },
  {
    title: '第五步：标本检索与教学复盘',
    body: '底部标本索引可以切换模型，右上角的标本索引入口可打开搜索遮罩快速定位。',
  },
];

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

function shouldShowInitialGuide() {
  try {
    return localStorage.getItem(GUIDE_STORAGE_KEY) !== '1';
  } catch {
    return false;
  }
}

function App() {
  const [activeId, setActiveId] = useState<string>(DEFAULT_MODEL_ID);
  const [generatedModels, setGeneratedModels] = useState<CellModel[]>(readStoredGeneratedModels);
  const [route, setRoute] = useState(() => (window.location.hash === '#about-ma' ? 'about' : 'workbench'));
  const [guideOpen, setGuideOpen] = useState(shouldShowInitialGuide);
  const [guideStep, setGuideStep] = useState(0);
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

  useEffect(() => {
    if (!guideOpen) return;
    try {
      localStorage.setItem(GUIDE_STORAGE_KEY, '1');
    } catch {
      // Ignore storage failures; the guide can still be opened from the top bar.
    }
  }, [guideOpen]);

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

  const openGuide = () => {
    setGuideStep(0);
    setGuideOpen(true);
  };

  const focusSpecimenIndex = () => {
    setRoute('workbench');
    window.location.hash = '#workbench';
    window.requestAnimationFrame(() => {
      document.getElementById('specimen-index-card')?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest',
      });
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="topbar-kicker" href="#workbench" aria-label="返回工作台">
          N° 07 · 细胞植物工坊 · 2026
        </a>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">間</div>
          <span className="brand-rule" aria-hidden="true" />
          <div>
            <h1 className="brand-title">间 MA · 生物工作台</h1>
            <p className="brand-tagline">
              <span>细胞工坊</span>
              <span className="brand-sep">·</span>
              <span>先确认图片，再进入 3D</span>
            </p>
          </div>
        </div>
        <nav className="topbar-nav" aria-label="界面区域">
          <a href="#workbench">工作台</a>
          <button type="button" onClick={openGuide}>流程引导</button>
          <button type="button" onClick={focusSpecimenIndex}>标本索引</button>
          <a href="#about-ma">关于</a>
          <a href="#about-ma">本地接口</a>
        </nav>
        <div className="hanko-mark" aria-hidden="true">間</div>
      </header>

      {route === 'about' ? (
        <main className="about-route" id="about-ma">
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

          <Sidebar
            models={allModels}
            activeId={activeId}
            onSelect={setActiveId}
            onOpenIndex={focusSpecimenIndex}
          />
        </main>
      )}

      <footer className="footer">
        <span>© {new Date().getFullYear()} 间 MA 细胞工坊</span>
        <span>文本 / 图像 / 3D · 教学工作台</span>
        <span>细胞工坊 × 三维生成</span>
      </footer>

      {guideOpen && (
        <GuideOverlay
          step={guideStep}
          onBack={() => setGuideStep((step) => Math.max(0, step - 1))}
          onNext={() => {
            if (guideStep >= GUIDE_STEPS.length - 1) {
              setGuideOpen(false);
              return;
            }
            setGuideStep((step) => step + 1);
          }}
          onClose={() => setGuideOpen(false)}
        />
      )}

    </div>
  );
}

function GuideOverlay({
  step,
  onBack,
  onNext,
  onClose,
}: {
  step: number;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const current = GUIDE_STEPS[step];
  const isLast = step === GUIDE_STEPS.length - 1;

  return (
    <div className="global-overlay" role="dialog" aria-modal="true" aria-label="生成流程引导">
      <section className="guide-panel">
        <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭引导">关闭</button>
        <span className="overlay-eyebrow">生成流程引导 · {String(step + 1).padStart(2, '0')} / {String(GUIDE_STEPS.length).padStart(2, '0')}</span>
        <h2>{current.title}</h2>
        <p>{current.body}</p>
        <div className="guide-steps">
          {GUIDE_STEPS.map((item, index) => (
            <button
              type="button"
              className={index === step ? 'active' : ''}
              key={item.title}
              onClick={() => {
                for (let i = 0; i < Math.abs(index - step); i += 1) {
                  if (index > step) onNext();
                  else onBack();
                }
              }}
              aria-label={`查看${item.title}`}
            />
          ))}
        </div>
        <div className="overlay-actions">
          <button type="button" className="overlay-secondary" onClick={onBack} disabled={step === 0}>上一步</button>
          <button type="button" className="overlay-primary" onClick={onNext}>{isLast ? '完成' : '下一步'}</button>
        </div>
      </section>
    </div>
  );
}

export default App;
