import { Suspense, useCallback, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Canvas } from '@react-three/fiber';
import { ContactShadows, Environment, Lightformer, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { CellModel } from '../data/models';
import { reloadModel, useModel } from '../hooks/useModel';
import { formatModelBytes, getModelLoadHint, isHeavyModel } from '../lib/modelWeight';
import { ModelScene } from './ModelScene';
import { ProgressOverlay } from './ProgressOverlay';

interface Props {
  model: CellModel;
  captureMode?: boolean;
}

export function ModelViewer({ model, captureMode = false }: Props) {
  const { status, progress, entry } = useModel(model.modelUrl, {
    autoStart: true,
    fileSize: model.fileSize,
  });
  const [autoRotate, setAutoRotate] = useState(false);
  const [modelFocus, setModelFocus] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clueOpen, setClueOpen] = useState(false);
  const [cluePinned, setCluePinned] = useState(false);
  const [canvasEventSource, setCanvasEventSource] = useState<HTMLDivElement | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const lastClueToggleAt = useRef(0);

  const isReady = status === 'done' && !!entry?.gltf;
  const showStageUi = captureMode || isReady;
  const heavyModel = isHeavyModel(model.fileSize);
  const renderDpr: [number, number] = heavyModel ? [1, 1.15] : [1, 1.35];
  const environmentResolution = heavyModel ? 80 : 112;
  const shadowMapSize = heavyModel ? 768 : 1024;
  const modelSizeLabel = formatModelBytes(model.fileSize);
  const modelLoadHint = getModelLoadHint(model.fileSize);
  const questionClue = buildQuestionClue(model);

  const toggleCluePinned = useCallback((event: ReactKeyboardEvent<HTMLButtonElement> | ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (Math.abs(event.timeStamp - lastClueToggleAt.current) < 90) return;
    lastClueToggleAt.current = event.timeStamp;
    setClueOpen(true);
    setCluePinned((value) => !value);
  }, []);

  const handleQuestionDrawerPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const isHandleHit = event.clientX >= rect.right - 52;
    if (isHandleHit) toggleCluePinned(event);
  }, [toggleCluePinned]);

  const bindCanvasEventSource = useCallback((node: HTMLDivElement | null) => {
    setCanvasEventSource(node);
  }, []);

  const bindControls = useCallback((controls: OrbitControlsImpl | null) => {
    if (!controls) {
      controlsRef.current?.stopListenToKeyEvents();
      controlsRef.current = null;
      return;
    }
    controlsRef.current = controls;
    controls.keyPanSpeed = 10;
    controls.listenToKeyEvents(window as unknown as HTMLElement);
  }, []);

  const handleReset = () => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.target.set(0, 0, 0);
    controls.object.position.set(0, 0, 4.4);
    controls.update();
  };

  const handleViewerPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!showStageUi) {
      setModelFocus(false);
      if (!cluePinned && clueOpen) setClueOpen(false);
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const isCentralModelZone = x > w * 0.18 && x < w * 0.82 && y > h * 0.14 && y < h * 0.86;

    if (target.closest('.stage-control-strip')) {
      setModelFocus(false);
      return;
    }

    if (target.closest('.stage-question-drawer')) {
      setClueOpen(true);
      setModelFocus(false);
      return;
    }

    if (target.closest('.stage-learning-rail')) {
      setModelFocus(isCentralModelZone || x < w * 0.78);
      return;
    }

    if (target.closest('.stage-note-panel, .stage-info-main')) {
      setModelFocus(isCentralModelZone);
      return;
    }

    const isQuestionHotZone = x > w - 72 && y > h * 0.52 && y < h - 36;
    if (isQuestionHotZone) {
      setClueOpen(true);
      setModelFocus(false);
      return;
    }

    if (!cluePinned && clueOpen) {
      setClueOpen(false);
    }

    const isOverlayLane =
      y < 154 && (x < 198 || x > w - 236) ||
      y > h - 154 && (x < 178 || x > w - 236) ||
      y > h - 76;

    setModelFocus(!isOverlayLane);
  }, [clueOpen, cluePinned, showStageUi]);

  return (
    <div
      className={`viewer${showStageUi ? ' is-model-ready' : ' is-model-loading'}${modelFocus ? ' is-model-focus' : ''}${expanded ? ' is-stage-expanded' : ''}${heavyModel ? ' has-heavy-model' : ''}`}
      onPointerMove={handleViewerPointerMove}
      onPointerLeave={() => setModelFocus(false)}
      data-testid="model-viewer"
    >
      <div className="viewer-interaction-frame">
        <div
          className="viewer-canvas-zone"
          ref={bindCanvasEventSource}
          onPointerEnter={() => setModelFocus(true)}
          onPointerMove={() => setModelFocus(true)}
        >
          {canvasEventSource && !captureMode ? (
            <Canvas
              eventSource={canvasEventSource}
              frameloop={autoRotate ? 'always' : 'demand'}
              shadows="percentage"
              dpr={renderDpr}
              camera={{ position: [0, 0, 4.4], fov: 45 }}
              gl={{
                antialias: true,
                preserveDrawingBuffer: true,
                powerPreference: 'high-performance',
              }}
              performance={{ min: heavyModel ? 0.58 : 0.72 }}
            >
              <ambientLight intensity={1.18} />
              <directionalLight
                position={[5, 6, 4]}
                intensity={2.18}
                castShadow
                shadow-mapSize-width={shadowMapSize}
                shadow-mapSize-height={shadowMapSize}
              />
              <directionalLight position={[-3, 2, -4]} intensity={1.04} />
              <directionalLight position={[0, 2.4, 5]} intensity={0.82} />
              <hemisphereLight args={['#fff1da', '#d9e4d2', 0.72]} />

              <Environment resolution={environmentResolution} frames={1} environmentIntensity={1.18}>
                <Lightformer form="rect" intensity={2.54} position={[0, 4, 4]} scale={[5.4, 2.4, 1]} />
                <Lightformer form="rect" intensity={1.62} position={[-4, 2, -2]} scale={[3.4, 4.4, 1]} />
                <Lightformer form="ring" intensity={1.08} position={[4, 1.5, -3]} scale={2.6} />
              </Environment>

              {isReady && entry?.gltf && (
                <Suspense fallback={null}>
                  <ModelScene
                    gltf={entry.gltf}
                    autoRotate={autoRotate}
                    initialRotationY={model.defaultRotationY}
                    displayScale={model.displayScale}
                  />
                </Suspense>
              )}

              <ContactShadows
                position={[0, -1.35, 0]}
                opacity={0.12}
                scale={6}
                blur={3.4}
                far={3.2}
              />

              <OrbitControls
                ref={bindControls}
                makeDefault
                enableDamping
                dampingFactor={0.08}
                minDistance={1.5}
                maxDistance={9}
              />
            </Canvas>
          ) : null}
        </div>
      </div>

      {captureMode && (
        <div className="stage-capture-poster" aria-hidden="true">
          <img src={model.imageUrl} alt="" />
        </div>
      )}

      {showStageUi && (
        <div className="stage-annotation stage-info stage-info-main">
          <span className="stage-kicker">§ 02 — 模型卡片</span>
          <h2 className="overlay-title">{model.name}</h2>
          <p className="overlay-sub">{model.subtitle}</p>
          <dl className="stage-meta-grid">
            <div>
              <dt>类别</dt>
              <dd>{model.category}</dd>
            </div>
            <div>
              <dt>尺寸</dt>
              <dd>{model.size}</dd>
            </div>
            <div>
              <dt>模型文件</dt>
              <dd>{modelSizeLabel}</dd>
            </div>
            <div>
              <dt>光镜可见</dt>
              <dd>{model.visibleInLM}</dd>
            </div>
          </dl>
          <div className="stage-load-note" data-testid="stage-load-note">
            <span>{heavyModel ? '加载提示' : '加载状态'}</span>
            <strong>{modelLoadHint}</strong>
          </div>
        </div>
      )}

      {showStageUi && (
        <article className="stage-annotation stage-note-panel" aria-label="标本笔记">
          <span>标本笔记</span>
          <p>{model.whereItOccurs.text}</p>
          <em>{model.whereItOccurs.habitat}</em>
        </article>
      )}

      {showStageUi && (
        <aside className="stage-learning-rail" aria-label="右侧教学栏" data-testid="stage-learning-rail">
          <section className="stage-order-card" aria-label="观察顺序" data-testid="stage-order-card">
            <header>
              <span>观察顺序</span>
              <small>{model.features.length} 项</small>
            </header>
            <ol>
              {model.features.slice(0, 4).map((feature, index) => (
                <li key={feature.name}>
                  <i>{String(index + 1).padStart(2, '0')}</i>
                  <strong>{feature.name}</strong>
                  <p>{feature.detail}</p>
                </li>
              ))}
            </ol>
          </section>

          {model.concepts?.length ? (
            <section className="stage-concept-card" aria-label="概念图解" data-testid="stage-concept-card">
              <header>
                <span>概念图解</span>
                <small>初高中</small>
              </header>
              <div className="concept-list">
                {model.concepts.slice(0, 2).map((concept) => (
                  <article key={concept.term}>
                    <div>
                      <strong>{concept.term}</strong>
                      <i>{concept.level}</i>
                    </div>
                    <p>{concept.explanation}</p>
                    <em>{concept.visualHint}</em>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      )}

      {showStageUi && (
        <aside
          className={`stage-drawer stage-question-drawer${clueOpen || cluePinned ? ' open' : ''}${cluePinned ? ' pinned' : ''}`}
          aria-label="提问线索"
          data-testid="stage-question-drawer"
          onPointerEnter={() => {
            setClueOpen(true);
          }}
          onPointerMove={() => {
            setClueOpen(true);
          }}
          onMouseEnter={() => {
            setClueOpen(true);
          }}
          onMouseMove={() => {
            setClueOpen(true);
          }}
          onPointerUp={handleQuestionDrawerPointerUp}
          onPointerLeave={() => {
            if (!cluePinned) setClueOpen(false);
          }}
          onMouseLeave={() => {
            if (!cluePinned) setClueOpen(false);
          }}
          onFocus={() => {
            setClueOpen(true);
          }}
          onBlur={(event) => {
            const nextTarget = event.relatedTarget;
            if (!cluePinned && !(nextTarget instanceof Node && event.currentTarget.contains(nextTarget))) {
              setClueOpen(false);
            }
          }}
        >
          <button
            type="button"
            aria-expanded={clueOpen || cluePinned}
            aria-label={cluePinned ? '取消固定提问线索' : '展开并固定提问线索'}
            onClick={toggleCluePinned}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') toggleCluePinned(event);
            }}
          >
            <span>提问线索</span>
            <small>{cluePinned ? '已固定' : '悬停展开'}</small>
          </button>
          <div className="question-clue">
            <span>课堂提问</span>
            <p>{questionClue}</p>
          </div>
        </aside>
      )}

      {showStageUi && (
        <div
          className="stage-control-strip"
          onPointerEnter={() => setModelFocus(false)}
          onPointerLeave={() => setModelFocus(true)}
        >
          <p className="overlay-tip" aria-hidden="true">
            拖拽旋转 · 滚轮缩放 · 右键平移 · 方向键平移
          </p>
          <div className="overlay-toolbar">
            <button
              type="button"
              className={`tool-btn${autoRotate ? ' active' : ''}`}
              onClick={() => setAutoRotate((v) => !v)}
            >
              <RotateIcon />
              {autoRotate ? '暂停旋转' : '自动旋转'}
            </button>
            <button type="button" className="tool-btn" onClick={handleReset}>
              <ResetIcon />
              复位
            </button>
            <button
              type="button"
              className={`tool-btn${expanded ? ' active' : ''}`}
              onClick={() => setExpanded((value) => !value)}
            >
              <ExpandIcon />
              {expanded ? '收起' : '全局'}
            </button>
          </div>
        </div>
      )}

      {!captureMode && !isReady && (
        <ProgressOverlay
          progress={progress}
          status={status}
          modelName={model.name}
          fileSize={model.fileSize}
          error={entry?.error}
          onRetry={() => reloadModel(model.modelUrl, { fileSize: model.fileSize })}
        />
      )}
    </div>
  );
}

function buildQuestionClue(model: CellModel) {
  const firstFeature = model.features[0]?.name;
  const secondFeature = model.features[1]?.name;
  const firstConcept = model.concepts?.[0]?.term;

  if (firstFeature && secondFeature && firstConcept) {
    return `如果先观察${firstFeature}，再追踪${secondFeature}，能怎样解释${firstConcept}在这个结构中的作用？`;
  }

  if (firstFeature && firstConcept) {
    return `观察${firstFeature}时，可以怎样把它和${firstConcept}联系起来？`;
  }

  if (firstFeature) {
    return `这个模型中最先看到的${firstFeature}，和它的功能有什么对应关系？`;
  }

  return `观察${model.name}时，哪一处结构最能说明它的主要功能？`;
}

function RotateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <polyline points="21 4 21 10 15 10" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 12 6 9 9 12" />
      <path d="M6 9v6a6 6 0 0 0 6 6h3" />
      <path d="M21 12l-3 3-3-3" />
      <path d="M18 15V9a6 6 0 0 0-6-6H9" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H3v5" />
      <path d="M3 3l7 7" />
      <path d="M16 3h5v5" />
      <path d="M21 3l-7 7" />
      <path d="M8 21H3v-5" />
      <path d="M3 21l7-7" />
      <path d="M16 21h5v-5" />
      <path d="M21 21l-7-7" />
    </svg>
  );
}
