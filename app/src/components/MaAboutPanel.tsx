export function MaAboutPanel() {
  return (
    <section className="about-panel">
      <div className="about-enso" aria-hidden="true">
        <svg viewBox="0 0 120 120">
          <path d="M 61 14 C 92 14 108 38 108 61 C 108 91 84 108 60 108 C 33 108 14 89 14 63 C 14 37 36 16 62 15" />
        </svg>
      </div>
      <div>
        <span className="card-eyebrow">§ ABOUT — MA CELL STUDIO</span>
        <h2>间 MA，是面向生物教学的生成式 3D 工作台</h2>
        <p>
          这个工作台服务于“文本或图片生成生物模型”的演示交付：先把描述转换为可确认的参考图，
          再由用户判断是否进入图生 3D 建模，最后把生成结果缓存到本地标本索引，并在 3D 舞台中用于讲解。
          它不是单纯展示页面，而是一套可以跑通输入、确认、建模、下载和教学观察的业务原型。
        </p>
      </div>
      <div className="about-principles">
        <div>
          <span>01</span>
          <strong>输入</strong>
          <p>支持生物结构描述和参考图片上传，用于植物细胞、动物细胞、神经元等教学场景。</p>
        </div>
        <div>
          <span>02</span>
          <strong>参考图</strong>
          <p>文生图阶段可接入 GPT Image、Gemini 或 NanoBanana2；未配置服务时使用本地演示图。</p>
        </div>
        <div>
          <span>03</span>
          <strong>人工确认</strong>
          <p>图片可以重试、接收或退回，避免把不合格的初稿直接送去付费 3D 建模。</p>
        </div>
        <div>
          <span>04</span>
          <strong>图生 3D</strong>
          <p>建模层预留腾讯混元 3D 接口，同时保留本地模拟任务，方便先验收流程再接付费服务。</p>
        </div>
        <div>
          <span>05</span>
          <strong>缓存展示</strong>
          <p>完成后的 GLB/GLTF 模型进入标本索引，前端可以切换、观察、复位视角和演示结构重点。</p>
        </div>
        <div>
          <span>06</span>
          <strong>教学组件</strong>
          <p>模型卡片、观察焦点、标本笔记、标本列表和局部预览共同组成课堂可讲解的工作区。</p>
        </div>
      </div>
      <div className="about-interface-note">
        <span>本地接口说明</span>
        <p>
          前端工作台默认运行在 <strong>http://127.0.0.1:5173</strong>，本地 API 默认运行在
          <strong> http://127.0.0.1:8791</strong>。健康检查地址为
          <strong> /api/health</strong>；前端通过 <strong>VITE_API_BASE</strong> 指向后端。
          当前版本可以先走本地演示任务，后续再按预算接入真实图片模型和腾讯混元 3D 服务。
        </p>
      </div>
      <a className="about-return" href="#workbench">返回工作台</a>
      <div className="about-stamp" aria-hidden="true">間</div>
    </section>
  );
}
