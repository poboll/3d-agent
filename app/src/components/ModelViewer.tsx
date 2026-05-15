import { Suspense, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
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
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  const isReady = status === 'done' && !!entry?.gltf;

  const handleReset = () => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.target.set(0, 0, 0);
    controls.object.position.set(0, 0, 4.4);
    controls.update();
  };

  return (
    <div className="viewer">
      <Canvas
        frameloop={autoRotate ? 'always' : 'demand'}
        dpr={[1, 1.35]}
        camera={{ position: [0, 0, 4.6], fov: 42 }}
        gl={{
          antialias: false,
          powerPreference: 'low-power',
          preserveDrawingBuffer: false,
        }}
      >
        <ambientLight intensity={0.82} />
        <directionalLight position={[4, 5, 5]} intensity={1.05} />
        <directionalLight position={[-4, 1, -3]} intensity={0.38} />

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

        <OrbitControls
          ref={controlsRef}
          makeDefault
          enableDamping
          dampingFactor={0.08}
          minDistance={1.5}
          maxDistance={9}
        />
      </Canvas>

      <div className="stage-info stage-info-main">
        <span className="stage-kicker">§ 02 — MODEL CARD</span>
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

      <div className="stage-info stage-info-steps" aria-label="观察顺序">
        <span className="stage-kicker">OBSERVE / 观察顺序</span>
        <ol>
          {model.features.slice(0, 4).map((feature, index) => (
            <li key={feature.name}>
              <span>{index + 1}</span>
              <strong>{feature.name}</strong>
            </li>
          ))}
        </ol>
      </div>

      <div className="stage-info stage-info-note">
        <span className="stage-kicker">TEACHING NOTE</span>
        <p>{model.description}</p>
      </div>

      <p className="overlay-tip" aria-hidden="true">
        拖拽旋转 · 滚轮缩放 · 右键平移
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
          复位视角
        </button>
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
