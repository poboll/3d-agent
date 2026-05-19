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
        <h2>间，是给生成流程留下判断与教学的位置</h2>
        <p>
          这个界面把侘寂纸面、朱印、圆相和细线分隔翻译成一个教学型生物工作台。它不把文本直接送入
          3D 建模，而是保留“描述 / 上传、参考图、确认、图升建模、缓存展示”的中间判断环节，让老师或学生
          能在课堂里解释每一步结果。
        </p>
      </div>
      <div className="about-principles">
        <div>
          <span>01</span>
          <strong>纸面</strong>
          <p>用浅纸色和细线压住界面噪音，让 3D 模型成为主角。</p>
        </div>
        <div>
          <span>02</span>
          <strong>确认</strong>
          <p>文生图之后由用户接收、退回或重试，确认后才进入图生 3D。</p>
        </div>
        <div>
          <span>03</span>
          <strong>教学</strong>
          <p>模型、结构、课堂提问和任务状态都围绕教学演示组织。</p>
        </div>
        <div>
          <span>04</span>
          <strong>本地接口</strong>
          <p>前端默认运行在 5173，API 默认运行在 8791，适合先用本地演示和缓存模型验收流程。</p>
        </div>
        <div>
          <span>05</span>
          <strong>服务接入</strong>
          <p>当前保留 GPT Image、Gemini、NanoBanana2 与腾讯混元入口，未配置密钥时走本地模拟结果。</p>
        </div>
        <div>
          <span>06</span>
          <strong>交付边界</strong>
          <p>系统先保证可运行、可教学、可扩展，真实付费建模服务可在后续按预算打开。</p>
        </div>
      </div>
      <div className="about-interface-note">
        <span>LOCAL STACK</span>
        <p>
          工作台地址：<strong>http://127.0.0.1:5173</strong>。后端健康检查：
          <strong> http://127.0.0.1:8791/api/health</strong>。前端通过 VITE_API_BASE 指向 API；
          默认流程会先生成或上传参考图，再创建 3D 任务并把结果写入模型索引。
        </p>
      </div>
      <a className="about-return" href="#workbench">返回工作台</a>
      <div className="about-stamp" aria-hidden="true">間</div>
    </section>
  );
}
