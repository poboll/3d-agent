import { useRef, useState } from 'react';
import type { CellModel } from '../data/models';
import { fetchDemoGeneratedModels, uploadLocalModel } from '../services/fusionApi';

interface Props {
  generatedModels: CellModel[];
  onModelsLoaded: (models: CellModel[]) => void;
  onModelCreated: (model: CellModel) => void;
  onSelect: (id: string) => void;
}

export function GenerationPanel({
  generatedModels,
  onModelsLoaded,
  onModelCreated,
  onSelect,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState('已接入本地后端，可先加载 3DCellForge 示例模型。');
  const [busy, setBusy] = useState(false);

  const handleLoadDemo = async () => {
    setBusy(true);
    setStatus('正在读取 3DCellForge 缓存模型...');
    try {
      const models = await fetchDemoGeneratedModels();
      onModelsLoaded(models);
      setStatus(models.length ? `已加载 ${models.length} 个缓存生成模型。` : '没有找到可用的缓存模型。');
      if (models[0]) onSelect(models[0].id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '读取示例模型失败。');
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (file: File) => {
    setBusy(true);
    setStatus(`正在导入 ${file.name}...`);
    try {
      const model = await uploadLocalModel(file);
      onModelCreated(model);
      onSelect(model.id);
      setStatus(`${model.name} 已导入并加入模型列表。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '本地模型导入失败。');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <section className="generation-panel">
      <div>
        <span className="generation-eyebrow">生成工作流</span>
        <h2>生成模型接入</h2>
        <p>先用缓存样例和本地 GLB 跑通闭环；腾讯混元生 3D 可在后端 provider 阶段继续接入。</p>
      </div>

      <div className="generation-actions">
        <button type="button" className="generation-primary" onClick={handleLoadDemo} disabled={busy}>
          加载 3DCellForge 样例
        </button>
        <button type="button" className="generation-secondary" onClick={() => inputRef.current?.click()} disabled={busy}>
          导入本地 GLB
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleUpload(file);
          }}
        />
      </div>

      <div className="generation-status">
        <span>{busy ? '处理中' : '状态'}</span>
        <p>{status}</p>
      </div>

      {generatedModels.length > 0 && (
        <div className="generated-count">
          <strong>{generatedModels.length}</strong>
          <span>个生成/导入模型已加入侧栏</span>
        </div>
      )}
    </section>
  );
}
