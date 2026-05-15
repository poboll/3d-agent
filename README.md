# 细胞结构工坊 · Cell Architecture Studio

一个面向中文课堂的交互式 3D 生物教学网页，支持对五个真实尺寸的细胞 / 分子模型进行旋转、缩放与观察。

> 🌱 _在显微镜下探索生命之美_

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

- 加载 `../3DCellForge/public/generated-models/` 下的缓存 GLB 样例。
- 上传本地 `.glb/.gltf` 并加入左侧“生成模型”列表。
- 输入文本创建生成任务，后端记录任务状态并写入本地任务库。
- 本地演示 provider 会复用 3DCellForge 缓存 GLB，模拟“文本描述 -> 参考图阶段 -> 3D 生成 -> GLB 缓存 -> 前端查看”的完整闭环。
- 页面刷新后会从浏览器本地存储恢复最近加入的生成模型。

运行后可用接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 后端健康检查与 provider 配置状态 |
| `GET` | `/api/3d/demo-models` | 读取 3DCellForge 缓存样例 |
| `POST` | `/api/3d/local-model?fileName=xxx.glb` | 上传本地 GLB/GLTF |
| `POST` | `/api/workflows/text-to-cell` | 创建文本生成生物模型任务 |
| `GET` | `/api/jobs` | 查看最近生成任务 |
| `GET` | `/api/jobs/:jobId` | 查看单个任务状态 |

运行时会生成两个本地目录，均已加入 `.gitignore`：

- `.generated-models/`：保存导入或生成后的 GLB/GLTF。
- `.workflow-store/`：保存任务 JSON 与事件日志。

腾讯混元生 3D provider 已预留配置检测入口：

```bash
TENCENT_SECRET_ID=xxx
TENCENT_SECRET_KEY=xxx
TENCENT_HUNYUAN_3D_ENDPOINT=xxx
```

当前版本不会真实调用腾讯云，也不会产生云 API 费用；真实接入需要继续补签名、提交任务、轮询任务、下载模型四段逻辑。

## 部署到 GitHub Pages

仓库内已经提供 `.github/workflows/deploy.yml`，把仓库推到 GitHub 后：

1. 进入 **Settings → Pages**
2. **Source** 选择 **GitHub Actions**
3. 推送到 `main` 分支即可自动构建并发布

工作流默认按 `/<仓库名>/` 作为站点根（兼容 `https://<user>.github.io/<repo>/`）。如果你要部署到根域名（自定义域名或用户主页 `user.github.io`），把 workflow 里的 `VITE_BASE` 改成 `"/"` 即可。

## 加载策略

- **优先加载**：用户进入页面后，会立即下载当前展示的模型（默认是体积最小、加载最快的 _植物细胞_，约 6 MB）。下载过程显示真实进度条与百分比。
- **后台静默**：默认模型解析完成后（或者 5 秒超时兜底），其它 4 个模型会按顺序串行下载，避免与首个模型抢占带宽。
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

本仓库的模型与图片源文件来自仓库作者本人提供的教学素材，仅用于课堂教学与科普展示。

Made with 🌱 for biology classrooms.
