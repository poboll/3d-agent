# 细胞结构工坊 · Cell Architecture Studio

一个面向中文课堂的交互式 3D 生物教学网页，支持细胞模型观察、参考图生成、图片确认、本地图生 3D 建模与模型缓存展示。

## 模型清单

| 概念 | 模型文件 | 简介 |
| --- | --- | --- |
| 植物细胞 | `app/public/models/plant-cell.glb` | 含细胞壁、叶绿体、大液泡等结构 |
| 动物细胞 | `app/public/models/animal-cell.glb` | 含细胞膜、内质网、高尔基体等 |
| 白细胞 | `app/public/models/white-blood-cell.glb` | 免疫系统的卫士 |
| 神经元 | `app/public/models/neuron.glb` | 树突、轴突与突触结构 |
| DNA 双螺旋 | `app/public/models/dna.glb` | 双螺旋骨架与碱基对 |

模型已使用 [Draco](https://google.github.io/draco/) 压缩，每个文件约 6 ~ 11 MB。

## 技术栈

- ⚡️ **Vite + React 19 + TypeScript** — 现代化前端工程
- 🎨 **three.js / @react-three/fiber / @react-three/drei** — WebGL 3D 渲染
- 🗜 **DRACOLoader（自带本地 wasm 解码器）** — 离线可用，无需访问 gstatic
- 🎯 **自定义流式加载器** — 用 `fetch + ReadableStream` 真实统计下载进度

## 本地开发

当前仓库已经加入融合后端，推荐在项目根目录启动：

```bash
npm --prefix app install
npm run dev:api
npm run dev:app
```

默认地址：

- 前端：`http://127.0.0.1:5173/`
- 后端：`http://127.0.0.1:8791/`

如果 8791 或 5173 已被占用，可以临时指定端口：

```bash
API_PORT=8792 npm run dev:api
VITE_API_BASE=http://127.0.0.1:8792 npm --prefix app run dev -- --host 127.0.0.1 --port 5174
```

构建：

```bash
npm run build
npm --prefix app run preview   # 本地预览构建产物
```

API 测试：

```bash
npm run test:api
```

## 融合生成工作流

本项目当前采用 LearningCell 作为主展示壳，吸收 3DCellForge 的生成模型缓存思路，已经具备以下能力：

- 加载 `../3DCellForge/public/generated-models/` 下的缓存 GLB。
- 上传本地 `.glb/.gltf` 并加入左侧“生成模型”列表。
- 输入文本后先生成单张 3D-ready 参考图，用户确认图片后再提交图生 3D 建模。
- gpt-5.5 负责打磨 3D-ready prompt，Responses 图像工具负责生成单张参考图，本地 ComfyUI 工作流负责 TripoSG 几何重建与 Hunyuan3D-Paint 贴图。
- 后端记录参考图、任务状态、埋点事件与生成模型缓存，方便恢复和排查。
- 本地缓存链路可在没有 GPU 服务时快速验证“参考图 -> 任务记录 -> 模型缓存 -> 前端查看”的闭环。
- 页面刷新后会从浏览器本地存储恢复最近加入的生成模型。

默认生成路线与 `/Users/Apple/Downloads/苏增烨申请/deploy_3d` 中的交付文档保持一致：

```text
短词 / 术语
  -> 3D-ready 单图参考图 prompt
  -> gpt-5.5 打磨后的 OpenAI Responses 图像参考图
  -> 用户确认图片
  -> ComfyUI 单图 workflow
  -> TripoSG raw GLB
  -> Hunyuan3D-Paint textured GLB
  -> 前端 3D 舞台加载 textured GLB
```

运行后可用接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 后端健康检查与 provider 配置状态 |
| `GET` | `/api/providers/status` | 查看 OpenAI、ComfyUI、本地缓存等 provider 状态 |
| `GET` | `/api/3d/demo-models` | 读取 3DCellForge 缓存模型 |
| `POST` | `/api/3d/local-model?fileName=xxx.glb` | 上传本地 GLB/GLTF |
| `POST` | `/api/references/text-to-image` | gpt-5.5 打磨 prompt 并生成参考图 |
| `POST` | `/api/workflows/full-text-to-3d` | 从术语开始执行默认完整生成链路 |
| `POST` | `/api/references/upload?fileName=xxx.png` | 上传参考图并进入缓存 |
| `GET` | `/api/references/:referenceId/image` | 读取参考图缓存图片 |
| `POST` | `/api/workflows/text-to-cell` | 使用确认后的 referenceId 创建图生 3D 任务 |
| `GET` | `/api/jobs` | 查看最近生成任务 |
| `GET` | `/api/jobs/:jobId` | 查看单个任务状态 |

运行时会生成以下本地目录，均已加入 `.gitignore`：

- `.generated-models/`：保存导入或生成后的 GLB/GLTF。
- `.reference-work/`：参考图上传和生成过程的临时写入目录。
- `.reference-cache/`：校验通过后的参考图缓存。
- `.reference-trash/`：失败或待清理的参考图临时文件。
- `.upload-work/` / `.upload-cache/` / `.upload-trash/`：本地 GLB/GLTF 上传流程目录。
- `.workflow-store/`：保存任务 JSON 与事件日志。

### Provider 配置

OpenAI GPT Image：

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.anhesea.top:9443/v1
OPENAI_PROMPT_MODEL=gpt-5.5
OPENAI_REVIEW_MODEL=gpt-5.5
OPENAI_REASONING_EFFORT=xhigh
OPENAI_DISABLE_RESPONSE_STORAGE=true
OPENAI_IMAGE_MODE=responses-tool
OPENAI_IMAGE_MODEL=gpt-5.5
OPENAI_IMAGE_TOOL_MODEL=gpt-image-2
OPENAI_IMAGE_SIZE=1024x1024
OPENAI_IMAGE_QUALITY=medium
OPENAI_IMAGE_FORMAT=png
```

默认实现使用 Responses API：先由 `gpt-5.5` 把术语打磨为 3D-ready 单图 prompt，再通过 Responses 的 `image_generation` 工具生成参考图。`OPENAI_IMAGE_MODE=images-api` 时可切换到 `/v1/images/generations` 备用路径。

本地 ComfyUI / TripoSG / Hunyuan3D-Paint：

```bash
COMFYUI_BASE_URL=http://47.242.195.8:8010
COMFYUI_WORKFLOW_TEMPLATE=server/workflows/bio_single_image_triposg_hy3dpaint_api.json
COMFYUI_STEPS=30
COMFYUI_FACES=30000
COMFYUI_GUIDANCE_SCALE=7
COMFYUI_TIMEOUT_MS=7200000
COMFYUI_POLL_INTERVAL_MS=15000
```

如果走 SSH 转发，可把 `COMFYUI_BASE_URL` 改为 `http://127.0.0.1:18188`。

腾讯混元生 3D provider 保留配置检测入口：

```bash
TENCENT_SECRET_ID=xxx
TENCENT_SECRET_KEY=xxx
TENCENT_HUNYUAN_3D_ENDPOINT=xxx
```

当前三维主路径为本地 ComfyUI 工作流。腾讯云 provider 的签名、提交任务、轮询任务、下载模型四段逻辑可在同一 provider 结构下继续扩展。

## 部署到 GitHub Pages

仓库内已经提供 `.github/workflows/deploy.yml`，把仓库推到 GitHub 后：

1. 进入 **Settings → Pages**
2. **Source** 选择 **GitHub Actions**
3. 推送到 `main` 分支即可自动构建并发布

工作流默认按 `/<仓库名>/` 作为站点根（兼容 `https://<user>.github.io/<repo>/`）。如果你要部署到根域名（自定义域名或用户主页 `user.github.io`），把 workflow 里的 `VITE_BASE` 改成 `"/"` 即可。

## 加载策略

- **优先加载**：用户进入页面后，会立即下载当前展示的模型（默认是体积最小、加载最快的 _植物细胞_，约 6 MB）。下载过程显示真实进度条与百分比。
- **后台静默**：默认模型解析完成后（或者 5 秒超时保护），其它 4 个模型会按顺序串行下载，避免与首个模型抢占带宽。
- **缓存命中**：浏览器对 `.glb` 启用 `force-cache`，再次访问几乎无需等待。
- **手动覆盖**：当用户点击侧边栏中尚未加载完成的模型时，该模型的下载会立刻提升到前台，并显示进度。

## 目录结构

```
.
├── .github/workflows/deploy.yml   # GitHub Pages 自动部署
├── README.md
├── app/                           # Vite 前端工程
│   ├── public/
│   │   ├── draco/                 # 自带的 Draco 解码器
│   │   ├── images/                # 细胞缩略图（已压缩）
│   │   └── models/                # 5 个 .glb 模型
│   ├── src/
│   │   ├── components/            # UI 组件（侧栏、3D 查看器、信息面板等）
│   │   ├── data/models.ts         # 5 个生物概念的数据
│   │   ├── hooks/useModel.ts      # 加载状态订阅 hook
│   │   ├── lib/modelLoader.ts     # 流式下载 + Draco 解析 + 缓存
│   │   ├── App.tsx
│   │   └── ...
│   └── package.json
└── （根目录其它是源文件备份，例如未压缩的 PNG 与 .draco.glb 原始资源）
```

## 许可与说明

本仓库的模型与图片源文件来自项目教学素材，生成链路用于课堂教学、科普展示与三维资产工作流验证。
