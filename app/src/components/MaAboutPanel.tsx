export function MaAboutPanel() {
  return (
    <section className="about-panel">
      <div className="about-enso" aria-hidden="true">
        <svg viewBox="0 0 120 120">
          <path d="M 61 14 C 92 14 108 38 108 61 C 108 91 84 108 60 108 C 33 108 14 89 14 63 C 14 37 36 16 62 15" />
        </svg>
      </div>
      <div>
        <span className="card-eyebrow">§ WORKBENCH — MA CELL STUDIO</span>
        <h2>一套从参考图确认到 3D 标本展示的教学工作台</h2>
        <p>
          间 MA 用于演示生物模型生成的完整链路：学生或老师先提交描述或图片，系统生成参考图，
          人工确认后再进入图生 3D 建模。模型完成后会进入本地缓存和标本索引，用于课堂观察、
          结构讲解和后续复盘。
        </p>
      </div>
      <div className="about-principles">
        <div>
          <span>01</span>
          <strong>输入区</strong>
          <p>支持文本描述和参考图片上传，可从植物细胞、动物细胞、神经元等模板开始。</p>
        </div>
        <div>
          <span>02</span>
          <strong>参考图确认</strong>
          <p>文生图阶段可接入 GPT Image、Gemini 或 NanoBanana2；本地演示模式会使用缓存图。</p>
        </div>
        <div>
          <span>03</span>
          <strong>人工判断</strong>
          <p>图片可以重试、接收或退回，避免把不合格初稿直接送入付费建模服务。</p>
        </div>
        <div>
          <span>04</span>
          <strong>图生 3D</strong>
          <p>建模层预留腾讯混元 3D 接口，同时保留本地模拟任务，便于先验收再接服务。</p>
        </div>
        <div>
          <span>05</span>
          <strong>缓存与展示</strong>
          <p>完成后的 GLB/GLTF 进入标本索引，前端可切换、观察、复位视角和放大舞台。</p>
        </div>
        <div>
          <span>06</span>
          <strong>课堂组件</strong>
          <p>模型卡片、观察焦点、标本笔记、标本列表和局部预览组成可讲解的工作区。</p>
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
