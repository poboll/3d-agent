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
    title: '读取样例模型',
    note: '返回已经缓存好的 GLB/GLTF 模型列表，前端会合并进底部标本索引。',
  },
  {
    method: 'POST',
    path: '/api/workflows/text-to-cell',
    title: '创建生成任务',
    note: '提交描述、模板和服务商，后端进入「文生图 -> 图片确认 -> 图生 3D」任务链路。',
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
          当前工作台保留本地样例链路，接口形态按后续接入图片生成服务和腾讯混元 3D 服务预留。
          前端通过 <strong>VITE_API_BASE</strong> 指向本地后端，默认地址为 <strong>{API_BASE}</strong>。
        </p>
      </div>

      <div className="api-flow" aria-label="生成流程">
        <span>用户输入文本 / 上传图片</span>
        <i />
        <span>参考图生成与确认</span>
        <i />
        <span>混元 3D 图生建模</span>
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
        <span>Upload Work</span>
        <i />
        <span>Validated Cache</span>
        <i />
        <span>Model Library</span>
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
        <span>联调建议</span>
        <p>
          建议先完成本地样例任务，把工作台、标本索引、3D 舞台和任务历史打通；
          生产服务接入时替换后端 provider，即可实现图片生成、确认回调和建模结果缓存。
        </p>
      </div>

      <a className="about-return" href="#workbench">返回工作台</a>
    </section>
  );
}
