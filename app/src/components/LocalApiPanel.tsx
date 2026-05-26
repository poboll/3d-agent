const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8791';

const endpoints = [
  {
    method: 'GET',
    path: '/api/health',
    title: '健康检查',
    note: '用于确认本地后端是否已经启动，适合放在联调前的第一项检查。',
  },
  {
    method: 'GET',
    path: '/api/3d/demo-models',
    title: '读取缓存模型',
    note: '返回已经缓存好的 GLB/GLTF 模型列表，前端会合并进底部标本索引。',
  },
  {
    method: 'POST',
    path: '/api/references/prompt-preview',
    title: '预览 3D-ready Prompt',
    note: '只调用 prompt 打磨流程，不生成图片，适合在正式生图前检查单主体、切面、材质和禁用项。',
  },
  {
    method: 'POST',
    path: '/api/references/text-to-image',
    title: '生成参考图',
    note: '提交生物结构描述，后端先用 gpt-5.5 打磨 3D-ready prompt，再通过 Responses 图像工具生成单张参考图。',
  },
  {
    method: 'POST',
    path: '/api/workflows/full-text-to-3d',
    title: '完整默认链路',
    note: '按「术语 -> prompt -> 单图 -> TripoSG raw.glb -> Hunyuan3D-Paint textured.glb」创建完整任务。',
  },
  {
    method: 'POST',
    path: '/api/references/upload',
    title: '上传参考图',
    note: '上传 PNG、JPEG 或 WebP 初版图片，进入工作目录、缓存目录和可清理目录的规范流程。',
  },
  {
    method: 'POST',
    path: '/api/workflows/text-to-cell',
    title: '确认图生建模',
    note: '提交已确认的 referenceId、模板和三维服务，后端调用本地 TripoSG + Hunyuan3D-Paint 工作流。',
  },
  {
    method: 'GET',
    path: '/api/jobs/:jobId',
    title: '查询任务进度',
    note: '轮询任务状态、阶段、进度和生成结果，完成后可进入 3D 舞台展示。',
  },
  {
    method: 'GET',
    path: '/api/jobs?limit=12',
    title: '最近任务列表',
    note: '读取最近的生成任务，供左侧生成工坊恢复历史记录和快速切换生成结果。',
  },
  {
    method: 'POST',
    path: '/api/3d/local-model?fileName=demo.glb',
    title: '上传本地模型',
    note: '用于导入机构自有 GLB/GLTF 资产，验证资产入库、缓存与舞台展示流程。',
  },
];

export function LocalApiPanel() {
  return (
    <section className="api-panel">
      <div className="api-watermark" aria-hidden="true">LOCAL API</div>
      <div className="api-panel-head">
        <span className="card-eyebrow">§ LOCAL INTERFACE — WORKBENCH ADAPTER</span>
        <h2>本地接口与生成链路</h2>
        <p>
          当前工作台已接入参考图缓存、OpenAI 文生图接口和本地 ComfyUI 三维生成适配器。
          前端通过 <strong>VITE_API_BASE</strong> 指向本地后端，默认地址为 <strong>{API_BASE}</strong>。
        </p>
      </div>

      <div className="api-flow" aria-label="生成流程">
        <span>用户输入文本 / 上传图片</span>
        <i />
        <span>GPT 参考图生成与确认</span>
        <i />
        <span>TripoSG + 混元贴图</span>
        <i />
        <span>下载缓存并展示</span>
      </div>

      <div className="api-status-grid" aria-label="接口接入状态">
        <div>
          <span>Runtime</span>
          <strong>{API_BASE}</strong>
        </div>
        <div>
          <span>Assets</span>
          <strong>GLB / GLTF</strong>
        </div>
        <div>
          <span>Workflow</span>
          <strong>Text → Image → 3D</strong>
        </div>
      </div>

      <div className="api-storage-flow" aria-label="上传缓存流程">
        <span>Reference Work</span>
        <i />
        <span>Reference Cache</span>
        <i />
        <span>Model Cache</span>
        <i />
        <span>Cleanup Queue</span>
      </div>

      <div className="api-grid">
        {endpoints.map((endpoint) => (
          <article className="api-endpoint" key={`${endpoint.method}-${endpoint.path}`}>
            <div>
              <span className={`api-method method-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
              <code>{endpoint.path}</code>
            </div>
            <h3>{endpoint.title}</h3>
            <p>{endpoint.note}</p>
          </article>
        ))}
      </div>

      <div className="api-note">
        <span>环境变量</span>
        <p>
          后端读取 <strong>OPENAI_API_KEY</strong>、<strong>OPENAI_IMAGE_MODEL</strong>、<strong>COMFYUI_BASE_URL</strong>、
          <strong>COMFYUI_WORKFLOW_TEMPLATE</strong> 等配置。生成结果统一写入本地缓存，再交给 3D 舞台加载。
        </p>
      </div>

      <a className="about-return" href="#workbench">返回工作台</a>
    </section>
  );
}
