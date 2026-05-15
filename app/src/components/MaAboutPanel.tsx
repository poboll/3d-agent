export function MaAboutPanel() {
  return (
    <section className="about-panel" id="about-ma">
      <div className="about-enso" aria-hidden="true">
        <svg viewBox="0 0 120 120">
          <path d="M 61 14 C 92 14 108 38 108 61 C 108 91 84 108 60 108 C 33 108 14 89 14 63 C 14 37 36 16 62 15" />
        </svg>
      </div>
      <div>
        <span className="card-eyebrow">§ ABOUT — MA CELL STUDIO</span>
        <h2>间，是给生成流程留下判断的位置</h2>
        <p>
          这个界面把侘寂纸面、朱印、圆相和细线分隔翻译成一个教学型生物工作台。核心不是展示概念，
          而是让老师或学生按“描述、参考图、确认、建模、观察”的顺序完成一次可讲解的 3D 生成流程。
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
          <p>文生图之后必须由用户判断，避免直接把不可控结果送去建模。</p>
        </div>
        <div>
          <span>03</span>
          <strong>教学</strong>
          <p>模型、结构、课堂提问和任务状态都围绕教学演示组织。</p>
        </div>
      </div>
      <a className="about-return" href="#workbench">返回工作台</a>
      <div className="about-stamp" aria-hidden="true">間</div>
    </section>
  );
}
