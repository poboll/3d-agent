import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { DEFAULT_MODEL_ID, MODELS } from './data/models';
import { Sidebar } from './components/Sidebar';
import { ModelViewer } from './components/ModelViewer';
import { GenerationPanel } from './components/GenerationPanel';
import { MaAboutPanel } from './components/MaAboutPanel';
import { LocalApiPanel } from './components/LocalApiPanel';
import type { CellModel } from './data/models';
import { trackEvent } from './lib/analytics';
import './app.css';

const GENERATED_MODELS_STORAGE_KEY = 'learning-cell-generated-models';
const GUIDE_STORAGE_KEY = 'ma-cell-workflow-guide-seen';

type Route = 'workbench' | 'about' | 'api';

interface GuideFrame {
  spotlightStyle: CSSProperties;
  panelStyle: CSSProperties;
  placement: 'left' | 'right' | 'top' | 'bottom' | 'stage';
}

const GUIDE_STEPS = [
  {
    title: '第一步：写描述或上传图片',
    body: '从左侧生成工坊开始，输入生物结构描述，也可以直接上传一张参考图。',
    targetId: 'generate',
    targetLabel: '生成工坊',
  },
  {
    title: '第二步：确认参考图',
    body: '文生图先产出初版图片，用户可以重试、接收或退回，确认后才进入 3D 建模。',
    targetId: 'reference-step',
    targetLabel: '参考图确认区',
  },
  {
    title: '第三步：图生 3D 建模',
    body: '确认图片后再调用本地样例链路或混元 3D 服务，生成结果会下载并缓存到模型索引。',
    targetId: 'workflow-actions',
    targetLabel: '图生建模按钮',
  },
  {
    title: '第四步：舞台观察模型',
    body: '中间舞台用于旋转、缩放和复位视角，右侧观察焦点辅助课堂讲解。',
    targetId: 'model-stage',
    targetLabel: '3D 模型舞台',
  },
  {
    title: '第五步：标本检索与教学复盘',
    body: '底部标本索引用两行列表切换模型，点击标本图会打开局部预览，不打断工作台。',
    targetId: 'specimen-index-card',
    targetLabel: '底部标本列表',
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

function getRouteFromHash(): Route {
  if (window.location.hash === '#about-ma') return 'about';
  if (window.location.hash === '#local-api') return 'api';
  return 'workbench';
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function buildGuideFrame(target: HTMLElement, targetId: string): GuideFrame {
  const rect = target.getBoundingClientRect();
  const safe = 18;
  const gap = 18;
  const focusPadding = targetId === 'model-stage' ? 10 : 8;
  const focusLeft = clamp(rect.left - focusPadding, safe, window.innerWidth - safe);
  const focusTop = clamp(rect.top - focusPadding, safe, window.innerHeight - safe);
  const focusRight = clamp(rect.right + focusPadding, safe, window.innerWidth - safe);
  const focusBottom = clamp(rect.bottom + focusPadding, safe, window.innerHeight - safe);
  const panelWidth = Math.min(300, window.innerWidth - safe * 2);
  const estimatedPanelHeight = targetId === 'model-stage' ? 230 : 210;

  let left = focusRight + gap;
  let top = focusTop + (focusBottom - focusTop) / 2 - estimatedPanelHeight / 2;
  let placement: GuideFrame['placement'];

  if (targetId === 'model-stage') {
    placement = 'stage';
    left = focusRight - panelWidth - 18;
    top = focusTop + (focusBottom - focusTop) * 0.42 - estimatedPanelHeight / 2;
  } else if (window.innerWidth - focusRight >= panelWidth + gap) {
    placement = 'right';
  } else if (focusLeft >= panelWidth + gap) {
    placement = 'left';
    left = focusLeft - panelWidth - gap;
  } else if (window.innerHeight - focusBottom >= estimatedPanelHeight + gap) {
    placement = 'bottom';
    left = focusLeft + (focusRight - focusLeft) / 2 - panelWidth / 2;
    top = focusBottom + gap;
  } else {
    placement = 'top';
    left = focusLeft + (focusRight - focusLeft) / 2 - panelWidth / 2;
    top = focusTop - estimatedPanelHeight - gap;
  }

  return {
    placement,
    spotlightStyle: {
      left: focusLeft,
      top: focusTop,
      width: Math.max(48, focusRight - focusLeft),
      height: Math.max(48, focusBottom - focusTop),
    },
    panelStyle: {
      left: clamp(left, safe, window.innerWidth - panelWidth - safe),
      top: clamp(top, safe, window.innerHeight - estimatedPanelHeight - safe),
      width: panelWidth,
    },
  };
}

function App() {
  const [activeId, setActiveId] = useState<string>(DEFAULT_MODEL_ID);
  const [generatedModels, setGeneratedModels] = useState<CellModel[]>(readStoredGeneratedModels);
  const [route, setRoute] = useState<Route>(() => (shouldShowInitialGuide() ? 'workbench' : getRouteFromHash()));
  const [guideOpen, setGuideOpen] = useState(shouldShowInitialGuide);
  const [guideStep, setGuideStep] = useState(0);
  const [guideFrame, setGuideFrame] = useState<GuideFrame | null>(null);
  const [indexFocusSignal, setIndexFocusSignal] = useState(0);
  const allModels = useMemo(() => [...MODELS, ...generatedModels], [generatedModels]);
  const activeModel = useMemo(
    () => allModels.find((m) => m.id === activeId) ?? MODELS[0],
    [activeId, allModels]
  );

  useEffect(() => {
    const syncRoute = () => {
      const nextRoute = getRouteFromHash();
      setRoute(nextRoute);
      if (nextRoute !== 'workbench') {
        setGuideOpen(false);
      }
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

  useEffect(() => {
    if (!guideOpen) return;
    const targetId = GUIDE_STEPS[guideStep]?.targetId;
    if (!targetId) return;
    let disposed = false;
    const timers: number[] = [];

    if (window.location.hash !== '#workbench') {
      window.history.replaceState(null, '', '#workbench');
    }

    const updateFrame = () => {
      const target = document.getElementById(targetId);
      if (!target || disposed) return;
      setGuideFrame(buildGuideFrame(target, targetId));
    };

    const timer = window.setTimeout(() => {
      const target = document.getElementById(targetId);
      if (!target || disposed) return;
      document.querySelectorAll('.guide-focus-target').forEach((element) => {
        element.classList.remove('guide-focus-target');
      });
      target.classList.add('guide-focus-target');
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest',
      });
      updateFrame();
      timers.push(window.setTimeout(updateFrame, 280));
    }, 80);
    timers.push(timer);

    window.addEventListener('resize', updateFrame);
    window.addEventListener('scroll', updateFrame, true);

    return () => {
      disposed = true;
      timers.forEach((item) => window.clearTimeout(item));
      window.removeEventListener('resize', updateFrame);
      window.removeEventListener('scroll', updateFrame, true);
      document.querySelectorAll('.guide-focus-target').forEach((element) => {
        element.classList.remove('guide-focus-target');
      });
    };
  }, [guideOpen, guideStep]);

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
    setRoute('workbench');
    window.location.hash = '#workbench';
    setGuideStep(0);
    setGuideOpen(true);
    trackEvent('guide_open');
  };

  const selectModel = (id: string) => {
    setActiveId(id);
    const model = allModels.find((item) => item.id === id);
    trackEvent('specimen_select', {
      modelId: id,
      modelName: model?.name,
      custom: Boolean(model?.custom),
    });
  };

  const focusSpecimenIndex = () => {
    setRoute('workbench');
    window.location.hash = '#workbench';
    setIndexFocusSignal((signal) => signal + 1);
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
          <a className={route === 'workbench' ? 'active' : ''} href="#workbench">常驻工作台</a>
          <button type="button" className={guideOpen ? 'active' : ''} onClick={openGuide}>流程引导</button>
          <button type="button" onClick={focusSpecimenIndex}>标本索引</button>
          <a className={route === 'about' ? 'active' : ''} href="#about-ma">关于</a>
          <a className={route === 'api' ? 'active' : ''} href="#local-api">本地接口</a>
        </nav>
        <div className="hanko-mark" aria-hidden="true">間</div>
      </header>

      {route === 'about' ? (
        <main className="about-route" id="about-ma">
          <MaAboutPanel />
        </main>
      ) : route === 'api' ? (
        <main className="about-route api-route" id="local-api">
          <LocalApiPanel />
        </main>
      ) : (
        <main className="layout" id="workbench">
          <aside className="control-rail" id="generate">
            <GenerationPanel
              generatedModels={generatedModels}
              onModelsLoaded={handleModelsLoaded}
              onModelCreated={handleModelCreated}
              onSelect={selectModel}
            />
          </aside>

          <section
            className="stage"
            id="model-stage"
            style={{ '--accent': activeModel.accent } as CSSProperties}
          >
            <ModelViewer key={activeModel.id} model={activeModel} />
          </section>

          <Sidebar
            models={allModels}
            activeId={activeId}
            onSelect={selectModel}
            onOpenIndex={focusSpecimenIndex}
            guideOpen={guideOpen}
            focusSignal={indexFocusSignal}
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
            const nextStep = guideStep + 1;
            setGuideStep(nextStep);
            trackEvent('guide_step', {
              step: nextStep + 1,
              targetId: GUIDE_STEPS[nextStep]?.targetId,
            });
          }}
          onStepChange={setGuideStep}
          onStepTrack={(nextStep) => trackEvent('guide_step', {
            step: nextStep + 1,
            targetId: GUIDE_STEPS[nextStep]?.targetId,
          })}
          onClose={() => setGuideOpen(false)}
          frame={guideFrame}
        />
      )}

    </div>
  );
}

function GuideOverlay({
  step,
  onBack,
  onNext,
  onStepChange,
  onStepTrack,
  onClose,
  frame,
}: {
  step: number;
  onBack: () => void;
  onNext: () => void;
  onStepChange: (step: number) => void;
  onStepTrack: (step: number) => void;
  onClose: () => void;
  frame: GuideFrame | null;
}) {
  const current = GUIDE_STEPS[step];
  const isLast = step === GUIDE_STEPS.length - 1;

  return (
    <div
      className={`guide-overlay guide-target-${current.targetId}`}
      role="dialog"
      aria-modal="true"
      aria-label="生成流程引导"
    >
      {frame && <div className={`guide-spotlight guide-spotlight-${frame.placement}`} style={frame.spotlightStyle} />}
      <section className={`guide-panel guide-panel-${frame?.placement ?? 'floating'}`} style={frame?.panelStyle}>
        <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭引导">关闭</button>
        <span className="overlay-eyebrow">生成流程引导 · {String(step + 1).padStart(2, '0')} / {String(GUIDE_STEPS.length).padStart(2, '0')}</span>
        <h2>{current.title}</h2>
        <p>{current.body}</p>
        <strong className="guide-target-label">当前定位：{current.targetLabel}</strong>
        <div className="guide-steps">
          {GUIDE_STEPS.map((item, index) => (
            <button
              type="button"
              className={index === step ? 'active' : ''}
              key={item.title}
              onClick={() => {
                onStepChange(index);
                onStepTrack(index);
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
