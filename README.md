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
- gpt-5.5 负责打磨 3D-ready prompt，本地图片网关的 GPT Image 负责生成单张参考图，本地 ComfyUI 工作流负责 TripoSG 几何重建、可选 Hunyuan3D-Paint 贴图与 Bio3D 后处理。
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
  -> 可选 Hunyuan3D-Paint textured GLB
  -> Bio3D final GLB
  -> 前端 3D 舞台优先加载 final GLB
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
OPENAI_IMAGE_SIZE=1536x1536
OPENAI_IMAGE_QUALITY=high
OPENAI_IMAGE_FORMAT=png
PROMPT_POLISH_TIMEOUT_MS=60000
PROMPT_PREVIEW_TIMEOUT_MS=15000
LOCAL_IMAGE_GATEWAY_IMAGE_RETRIES=2
```

默认实现使用 Responses API：先由 `gpt-5.5` 把术语打磨为 3D-ready 单图 prompt，再通过 Responses 的 `image_generation` 工具生成参考图。`OPENAI_IMAGE_MODE=images-api` 时可切换到 `/v1/images/generations` 备用路径。

默认参考图配置为 `1536x1536 / high`，用于兼顾图生 3D 的结构清晰度和本地生成耗时；这不是 2K/4K。若网关支持并且预算允许，可把 `OPENAI_IMAGE_SIZE` 或 `LOCAL_IMAGE_GATEWAY_IMAGE_SIZE` 调高。

为保证课堂演示时不长时间停在 prompt 打磨阶段，`PROMPT_POLISH_TIMEOUT_MS` 默认 60 秒，超时后会使用本地 3D-ready 模板继续文生图；`PROMPT_PREVIEW_TIMEOUT_MS` 默认 15 秒，仅影响预览接口。图片生成保留网关级长超时，并对临时上游错误按 `LOCAL_IMAGE_GATEWAY_IMAGE_RETRIES` 重试。

本地 ComfyUI / TripoSG / Bio3D 稳定链路：

```bash
COMFYUI_BASE_URL=http://47.242.195.8:8010
COMFYUI_WORKFLOW_TEMPLATE=server/workflows/bio_single_image_triposg_bio3d_api.json
COMFYUI_STEPS=16
COMFYUI_FACES=12000
COMFYUI_GUIDANCE_SCALE=6
COMFYUI_HY3DPAINT_ENABLED=true
COMFYUI_HY3DPAINT_WORKFLOW_TEMPLATE=server/workflows/bio_single_image_triposg_hy3dpaint_api.json
COMFYUI_HY3DPAINT_EXISTING_MESH_WORKFLOW_TEMPLATE=server/workflows/bio_existing_mesh_hy3dpaint_postprocess_api.json
COMFYUI_HY3DPAINT_STEPS=10
COMFYUI_HY3DPAINT_FACES=3000
COMFYUI_HY3DPAINT_GUIDANCE_SCALE=4
COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST=false
COMFYUI_HY3DPAINT_FULL_WORKFLOW_STEPS=12
COMFYUI_HY3DPAINT_FULL_WORKFLOW_FACES=6000
COMFYUI_HY3DPAINT_FULL_WORKFLOW_GUIDANCE_SCALE=5
COMFYUI_HY3DPAINT_STABLE_STEPS=12
COMFYUI_HY3DPAINT_STABLE_FACES=3000
COMFYUI_HY3DPAINT_STABLE_GUIDANCE_SCALE=5
COMFYUI_HY3DPAINT_MIN_RAM_FREE_GB=16.5
COMFYUI_HY3DPAINT_MIN_TOTAL_RAM_GB=19
COMFYUI_HY3DPAINT_LOW_MEMORY_TOTAL_RAM_GB=24
COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED=true
COMFYUI_HY3DPAINT_MIN_VRAM_FREE_GB=14
COMFYUI_HY3DPAINT_RUNTIME_MIN_RAM_FREE_GB=5.5
COMFYUI_HY3DPAINT_RUNTIME_MIN_VRAM_FREE_GB=8
COMFYUI_HY3DPAINT_RUNTIME_GUARD_GRACE_POLLS=1
COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_COUNT=2
COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_MS=10800000
COMFYUI_HY3DPAINT_ABORT_ON_UNOBSERVABLE=false
COMFYUI_HY3DPAINT_POLL_INTERVAL_MS=5000
COMFYUI_HY3DPAINT_TIMEOUT_MS=10800000
COMFYUI_HY3DPAINT_AUTO_FALLBACK=true
COMFYUI_HY3DPAINT_FULL_RETRY_ON_TIMEOUT=false
COMFYUI_HY3DPAINT_UNOBSERVABLE_RECOVERY_LIMIT=48
COMFYUI_HY3DPAINT_STALE_HISTORY_LIMIT=80
COMFYUI_RESOURCE_GUARD=true
COMFYUI_MIN_RAM_FREE_GB=10
COMFYUI_MIN_VRAM_FREE_GB=6
COMFYUI_LOCAL_QUEUE_MAX_PENDING=1
COMFYUI_BLOCK_WHEN_REMOTE_BUSY=true
COMFYUI_FREE_AFTER_JOB=true
COMFYUI_FREE_TIMEOUT_MS=12000
COMFYUI_DRAIN_AFTER_JOB_TIMEOUT_MS=90000
COMFYUI_DRAIN_AFTER_JOB_POLL_MS=5000
COMFYUI_PREFLIGHT_FREE_BEFORE_GUARD=true
COMFYUI_TIMEOUT_MS=7200000
COMFYUI_POLL_INTERVAL_MS=15000
COMFYUI_HISTORY_POLL_TIMEOUT_MS=20000
COMFYUI_QUEUE_POLL_TIMEOUT_MS=8000
COMFYUI_UNOBSERVABLE_RECOVERY_LIMIT=3
COMFYUI_HISTORY_CACHE_LIMIT=60
WORKFLOW_JOB_RETENTION_LIMIT=80
WORKFLOW_EVENT_RETENTION_LIMIT=800
WORKFLOW_EVENT_COMPACT_INTERVAL=40
```

如果走 SSH 转发，可把 `COMFYUI_BASE_URL` 改为 `http://127.0.0.1:18188`。

自部署 3D 服务在 20GB 级显存、约 19GB 系统内存的机器上长时间运行时，主要风险是 ComfyUI / 子进程被 OOM killer 重启或 Hunyuan3D-Paint 长时间占住 ComfyUI HTTP 主进程。当前默认使用保守教学档 `16 steps / 12000 faces / guidance 6` 产出稳定几何版；如果用户请求混元贴图，系统默认先复用已完成的 raw GLB 走 existing-mesh Hunyuan3D-Paint，避免再次执行高面数 TripoSG；完整链路保留为显式开关 `COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST=true`，且默认完整链路低内存档为 `12 steps / 6000 faces / guidance 5`，避免把 20GB 服务器拖回 OOM 风险。20GB 机器不再被 24GB 总内存线永久拦截：默认 `COMFYUI_HY3DPAINT_MIN_TOTAL_RAM_GB=19`，总内存低于 `COMFYUI_HY3DPAINT_LOW_MEMORY_TOTAL_RAM_GB=24` 时进入低内存贴图模式。默认 `COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED=true`，代表系统会在远端队列为空、预检可用 RAM 不低于 16.5GB、可用 VRAM 不低于 14GB 时，提交一次受控 Hunyuan3D-Paint 贴图试跑；不会把多个贴图任务并发塞进远端队列。

20GB 模式下 `COMFYUI_HY3DPAINT_FULL_RETRY_ON_TIMEOUT` 默认关闭：existing-mesh 贴图如果只是慢或超时，不会自动追加更重的完整 Hunyuan 链路，系统会保留稳定 GLB、嵌入确认参考图生成本地轻量贴图 fallback，并允许用户稍后按 prompt_id 续接。远端 Hunyuan wrapper 的 20GB 运行档使用 `HY3DPAINT_RENDER_SIZE=1024`、`HY3DPAINT_TEXTURE_SIZE=1024`、`HY3DPAINT_IMAGE_MAX_SIZE=1024` 与 `HY3DPAINT_CPU_OFFLOAD=1`，同时把节点超时放宽到 2700 秒；若超时前后已经写出有效 GLB，wrapper 会优先回收该 GLB 而不是误判失败。实机试跑显示 Hunyuan3D-Paint 会把 20GB 主机可用 RAM 从约 17GB 压到约 4.6-6GB，因此运行中 RAM 硬熔断线设为 5.5GB，VRAM 硬熔断线仍为 8GB；低于硬线并达到 `COMFYUI_HY3DPAINT_RUNTIME_GUARD_GRACE_POLLS=1` 时，后端会主动调用 `/interrupt`，保留稳定 raw/final GLB，并嵌入确认参考图生成本地轻量贴图 fallback，避免回到白模或拖到 OOM。同一 resolved raw mesh 连续 `COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_COUNT=2` 次触发运行熔断后，会按 `COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_MS=10800000` 退避约 3 小时，期间直接生成彩色 fallback，不再反复挤压同一台 20GB 服务器。若需要最保守的课堂演示模式，可显式设置 `COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED=false`，此时 20GB 主机会直接使用稳定 GLB 的本地轻量贴图 fallback，不提交远端混元贴图。

资源保护始终启用：提交 TripoSG/Bio3D 或 Hunyuan3D-Paint 前会检查远端总 RAM、可用 RAM 与 VRAM，低于安全线时先调用 ComfyUI `/free` 释放缓存并复查，仍不足时暂停远端贴图或新 3D 重任务。前端和 API 会把冷启动、空回复、502/503/504、socket 断开识别为可恢复状态，并保留 `prompt_id` 供继续拉取 history 与 GLB。稳定几何版在末段 history 与 queue 连续不可观测 3 次时会收敛成可续接失败；混元贴图阶段默认不因 HTTP 暂时不可观测而中断，只在 RAM/VRAM 明确跌破运行熔断线时调用 `/interrupt`。API 侧会把自部署 3D 重任务串行化为“本地保护队列”，默认最多只允许 1 个等待任务，并在远端 ComfyUI 队列非空时暂停新提交，避免连续点击造成远端并发 OOM；每个重任务结束后默认调用 ComfyUI `/free` 释放模型与显存缓存，并继续等待远端 queue drain，避免本地 slot 提前释放后马上叠加下一轮重任务。本地状态也会做长跑压缩：保留最近 80 个 workflow job、最近 800 条 job event、最近 60 份 ComfyUI history 缓存；失败但带 `prompt_id` 的自部署任务优先保留，方便稍后诊断或续接。远端建议使用 `--lowvram --reserve-vram 2.5 --cache-none`、`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True,garbage_collection_threshold:0.8` 和 `MALLOC_ARENA_MAX=2`，并保留 systemd `Restart=on-failure`。

贴图稳定性复测可以复用最近一个已完成的 selfhost raw GLB，连续触发“混元后处理 / 轻量贴图 fallback / GLB 检查”：

```bash
npm run smoke:texture-artifacts
npm run smoke:texture-stability -- --runs=3 --timeout-minutes=80 --cooldown-ms=20000 --drain-timeout-ms=180000 --min-ram-recovery-gib=16.5
```

`smoke:texture-artifacts` 只检查最近已有的 selfhost 贴图产物，不提交新的 Hunyuan3D-Paint 重任务；适合每轮 UI/API 迭代后快速确认 final GLB 不是白模。`smoke:texture-stability` 才会串行创建贴图增强任务，运行前应确认远端队列为空、RAM/VRAM 达标。

最近一次实机报告写入 `.workflow-store/texture-stability-latest.json`：3/3 完成、3/3 产出非白模彩色 GLB、0 失败；后续 GLB 检查会以 mesh 实际使用的 active material 为准，要求 active material 带嵌入 texture 或非白 baseColor，避免旧白色材质残留导致误判。结论是：当前 20GB 服务器上 native Hunyuan3D-Paint existing-mesh 仍会压低系统 RAM，稳定可复现的生产路径是“受控 Hunyuan 尝试 -> 运行熔断/退避 -> Bio3D 轻量贴图 fallback -> 非白模彩色 GLB”。如果要稳定拿到原生 Hunyuan 贴图，需要更高系统内存或继续优化远端节点级 offload/贴图分辨率。

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
