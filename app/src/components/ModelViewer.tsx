import { Suspense, useCallback, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { ContactShadows, Environment, Lightformer, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { CellModel } from '../data/models';
import { useModel } from '../hooks/useModel';
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

  return (
    <div className={`viewer${modelFocus ? ' is-model-focus' : ''}${expanded ? ' is-stage-expanded' : ''}`}>
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
            <ambientLight intensity={0.55} />
            <directionalLight
              position={[5, 6, 4]}
              intensity={1.1}
              castShadow
              shadow-mapSize-width={1024}
              shadow-mapSize-height={1024}
            />
            <directionalLight position={[-3, 2, -4]} intensity={0.35} />

            <Environment resolution={96} frames={1} environmentIntensity={0.58}>
              <Lightformer form="rect" intensity={1.6} position={[0, 4, 4]} scale={[5, 2, 1]} />
              <Lightformer form="rect" intensity={0.9} position={[-4, 2, -2]} scale={[3, 4, 1]} />
              <Lightformer form="ring" intensity={0.55} position={[4, 1.5, -3]} scale={2.4} />
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
              opacity={0.32}
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

      <aside className="stage-annotation stage-learning-panel" aria-label="观察焦点与概念解读">
        <article className="stage-side-card stage-focus-card">
          <span className="stage-kicker">观察焦点</span>
          <ol>
            {model.features.slice(0, 4).map((feature, index) => (
              <li key={feature.name}>
                <i>{String(index + 1).padStart(2, '0')}</i>
                <div>
                  <strong>{feature.name}</strong>
                  <p>{feature.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </article>
      </aside>

      <article className="stage-annotation stage-note-panel" aria-label="标本笔记">
        <span>标本笔记</span>
        <p>{model.whereItOccurs.text}</p>
        <em>{model.whereItOccurs.habitat}</em>
      </article>

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
