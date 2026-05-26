import { Suspense, useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Canvas } from '@react-three/fiber';
import { ContactShadows, Environment, Lightformer, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { CellModel } from '../data/models';
import { reloadModel, useModel } from '../hooks/useModel';
import { ModelScene } from './ModelScene';
import { ProgressOverlay } from './ProgressOverlay';

interface Props {
  model: CellModel;
}

export function ModelViewer({ model }: Props) {
  const { status, progress, entry } = useModel(model.modelUrl, {
    autoStart: true,
    fileSize: model.fileSize,
  });
  const [autoRotate, setAutoRotate] = useState(false);
  const [modelFocus, setModelFocus] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clueOpen, setClueOpen] = useState(false);
  const [cluePinned, setCluePinned] = useState(false);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  const isReady = status === 'done' && !!entry?.gltf;

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
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest('.stage-control-strip, .stage-question-drawer')) {
      return;
    }

    setModelFocus(true);
  }, []);

  return (
    <div
      className={`viewer${modelFocus ? ' is-model-focus' : ''}${expanded ? ' is-stage-expanded' : ''}`}
      onPointerMove={handleViewerPointerMove}
      onPointerLeave={() => setModelFocus(false)}
    >
      <div className="viewer-interaction-frame">
        <div
          className="viewer-canvas-zone"
          onPointerMove={() => setModelFocus(true)}
          onPointerLeave={() => setModelFocus(false)}
        >
          <Canvas
            frameloop={autoRotate ? 'always' : 'demand'}
            shadows="percentage"
            dpr={[1, 1.5]}
            camera={{ position: [0, 0, 4.4], fov: 45 }}
            gl={{
              antialias: true,
              preserveDrawingBuffer: true,
            }}
          >
            <ambientLight intensity={0.72} />
            <directionalLight
              position={[5, 6, 4]}
              intensity={1.28}
              castShadow
              shadow-mapSize-width={1024}
              shadow-mapSize-height={1024}
            />
            <directionalLight position={[-3, 2, -4]} intensity={0.48} />

            <Environment resolution={96} frames={1} environmentIntensity={0.74}>
              <Lightformer form="rect" intensity={1.95} position={[0, 4, 4]} scale={[5, 2, 1]} />
              <Lightformer form="rect" intensity={1.1} position={[-4, 2, -2]} scale={[3, 4, 1]} />
              <Lightformer form="ring" intensity={0.7} position={[4, 1.5, -3]} scale={2.4} />
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
              opacity={0.28}
              scale={6}
              blur={2.4}
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
        </div>
      </div>

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
            <dt>光镜可见</dt>
            <dd>{model.visibleInLM}</dd>
          </div>
        </dl>
      </div>

      <article className="stage-annotation stage-note-panel" aria-label="标本笔记">
        <span>标本笔记</span>
        <p>{model.whereItOccurs.text}</p>
        <em>{model.whereItOccurs.habitat}</em>
      </article>

      {model.concepts?.length ? (
        <aside className="stage-annotation stage-concept-card" aria-label="概念图解">
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
        </aside>
      ) : null}

      <aside className="stage-order-card" aria-label="观察顺序">
        <header>
          <span>观察顺序</span>
          <small>固定</small>
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
      </aside>

      <aside
        className={`stage-drawer stage-question-drawer${clueOpen || cluePinned ? ' open' : ''}${cluePinned ? ' pinned' : ''}`}
        aria-label="提问线索"
        onPointerEnter={() => {
          setModelFocus(false);
          setClueOpen(true);
        }}
        onPointerLeave={() => {
          if (!cluePinned) setClueOpen(false);
        }}
      >
        <button type="button" aria-expanded={clueOpen || cluePinned} onClick={() => setCluePinned((value) => !value)}>
          <span>提问线索</span>
          <small>{cluePinned ? '已展开' : '点击展开'}</small>
        </button>
        <div className="question-clue">
          <span>课堂提问</span>
          <p>例如一片成熟的叶子里，可能含有数百万个叶绿体。</p>
        </div>
      </aside>

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

      {!isReady && (
        <ProgressOverlay
          progress={progress}
          status={status}
          modelName={model.name}
          error={entry?.error}
          onRetry={() => reloadModel(model.modelUrl, { fileSize: model.fileSize })}
        />
      )}
    </div>
  );
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
