# 间 MA 工作台：本地 3D 生成与 GPT 文生图部署说明

## 目标链路

```text
用户输入术语 / 课堂描述 / 上传图片
  -> 后端打磨 3D-ready 单图 prompt
  -> 本地图片网关 / GPT Image 生成单张参考图，或缓存用户上传图片
  -> 用户确认参考图
  -> ComfyUI 单图工作流
  -> TripoSG 输出 raw.glb
  -> Bio3D 后处理输出 final.glb
  -> 后端下载并缓存 GLB
  -> 前端 3D 舞台优先展示 final.glb
```

当前实现按 `/Users/Apple/Downloads/苏增烨申请/deploy_3d/BIO_3D_FINAL_HANDOFF.md` 收敛后的路线接入：

- gpt-5.5 使用 Responses API 打磨 3D-ready prompt，并优先通过本地图片网关生成单张参考图。
- ComfyUI 默认使用稳定单图 workflow：`LoadImage -> TripoSGImageTo3D -> Bio3DPostProcessGLB -> Preview3D`。
- 前端默认展示 `final.glb`，必要时可保留 `raw.glb` 做几何诊断；Hunyuan3D-Paint 贴图链路保留为后续增强，不阻塞课堂演示主流程。
- 不默认使用四宫格、多视角拼图；当前固定结论是“只用单张 3D-ready 剖面图”。

## 当前接口配置口径

本机已经把已授权的 OpenAI 供应商配置写入 `LearningCell/.env.local`。该文件已被 `.gitignore` 忽略，不会提交到版本库，也不应复制给客户或外部仓库。

交付、部署和客户文档只记录变量名与配置方式，不展示明文密钥：

```bash
OPENAI_API_KEY=<填写已授权的 OpenAI API Key>
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

LOCAL_IMAGE_GATEWAY_BASE_URL=http://127.0.0.1:48760
LOCAL_IMAGE_GATEWAY_API_KEY=<填写本地图片网关 API Key>
LOCAL_IMAGE_GATEWAY_PROMPT_MODEL=gpt-5.5
LOCAL_IMAGE_GATEWAY_IMAGE_MODEL=gpt-image-2
LOCAL_IMAGE_GATEWAY_IMAGE_MODEL_FALLBACKS=gpt-image-2,gpt-image-1.5,gpt-image-1
LOCAL_IMAGE_GATEWAY_REASONING_EFFORT=xhigh
LOCAL_IMAGE_GATEWAY_DISABLE_RESPONSE_STORAGE=true
LOCAL_IMAGE_GATEWAY_IMAGE_SIZE=1536x1536
LOCAL_IMAGE_GATEWAY_IMAGE_QUALITY=high
LOCAL_IMAGE_GATEWAY_IMAGE_FORMAT=png
PROMPT_POLISH_TIMEOUT_MS=60000
PROMPT_PREVIEW_TIMEOUT_MS=15000
LOCAL_IMAGE_GATEWAY_IMAGE_RETRIES=2
DEFAULT_IMAGE_PROVIDER=local-gateway
```

当前默认是质量优先的 `1536x1536 / high` 单图参考图，并不是 2K 或 4K。若演示需要更高分辨率，可通过 `OPENAI_IMAGE_SIZE` 或 `LOCAL_IMAGE_GATEWAY_IMAGE_SIZE` 调整到网关支持的尺寸；尺寸越大，等待时间、显存压力和失败重试成本也会相应上升。

完整生成会先尝试使用 `gpt-5.5` 打磨 3D-ready prompt。为了避免演示时长时间停留在“模型打磨”，`PROMPT_POLISH_TIMEOUT_MS` 默认 60 秒，超时后自动回退到本地模板 prompt 并继续生成图片；`PROMPT_PREVIEW_TIMEOUT_MS` 默认 15 秒，仅用于 prompt 预览。图片生成阶段仍使用 `LOCAL_IMAGE_GATEWAY_TIMEOUT_MS` 的长超时，并通过 `LOCAL_IMAGE_GATEWAY_IMAGE_RETRIES` 处理偶发上游失败。

三维生成服务使用本地/自托管 ComfyUI：

```bash
COMFYUI_BASE_URL=http://47.242.195.8:8010
COMFYUI_WORKFLOW_TEMPLATE=server/workflows/bio_single_image_triposg_bio3d_api.json
COMFYUI_HY3DPAINT_WORKFLOW_TEMPLATE=server/workflows/bio_single_image_triposg_hy3dpaint_api.json
COMFYUI_HY3DPAINT_EXISTING_MESH_WORKFLOW_TEMPLATE=server/workflows/bio_existing_mesh_hy3dpaint_postprocess_api.json
COMFYUI_STEPS=16
COMFYUI_FACES=12000
COMFYUI_GUIDANCE_SCALE=6
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
COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST=false
COMFYUI_HY3DPAINT_FULL_WORKFLOW_STEPS=12
COMFYUI_HY3DPAINT_FULL_WORKFLOW_FACES=6000
COMFYUI_HY3DPAINT_FULL_WORKFLOW_GUIDANCE_SCALE=5
COMFYUI_HY3DPAINT_FULL_RETRY_ON_TIMEOUT=false
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

这组默认值是为 20GB 显存、约 19GB 系统内存的自部署机器准备的稳定档。若 `/system_stats` 显示 RAM 或 VRAM 低于安全线，后端会先调用 ComfyUI `/free` 释放缓存并复查，仍不足时暂停新的 TripoSG/Bio3D 重任务，避免 OOM killer 再次终止 Python 进程；参考图生成和历史任务续接仍可继续操作。20GB 机器现在会进入低内存贴图模式：总内存低于 24GB 只会标记为低内存模式，不再直接拦截。默认 `COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED=true`，因此只要远端队列为空、预检可用 RAM 不低于 16.5GB、可用 VRAM 不低于 14GB，就会提交一次受控 Hunyuan3D-Paint 贴图试跑；API 侧不会把多个贴图任务并发塞进远端队列。

默认 `COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST=false`，贴图增强优先复用稳定 raw GLB 走 existing-mesh 后处理，不重跑高面数 TripoSG；`COMFYUI_HY3DPAINT_FULL_RETRY_ON_TIMEOUT=false`，因此 existing-mesh 贴图超时不会自动追加更重的完整 Hunyuan 链路，系统会保留稳定 GLB、嵌入确认参考图生成本地轻量贴图 fallback，并允许稍后按 `prompt_id` 续接。远端 Hunyuan wrapper 的 20GB 运行档使用 `HY3DPAINT_RENDER_SIZE=1024`、`HY3DPAINT_TEXTURE_SIZE=1024`、`HY3DPAINT_IMAGE_MAX_SIZE=1024` 与 `HY3DPAINT_CPU_OFFLOAD=1`，同时把节点超时放宽到 2700 秒；若超时前后已经写出有效 GLB，wrapper 会优先回收该 GLB 而不是误判失败。实机试跑显示 Hunyuan3D-Paint 会把 20GB 主机可用 RAM 从约 17GB 压到约 4.6-6GB，因此运行中 RAM 硬熔断线为 5.5GB，VRAM 硬熔断线为 8GB。低于硬线并达到 `COMFYUI_HY3DPAINT_RUNTIME_GUARD_GRACE_POLLS=1` 时，后端会主动 `/interrupt`，保留稳定 raw/final GLB，并嵌入确认参考图生成本地轻量贴图 fallback，避免白模和 OOM。同一 resolved raw mesh 连续 `COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_COUNT=2` 次触发运行熔断后，会按 `COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_MS=10800000` 退避约 3 小时，期间直接生成彩色 fallback，不再反复挤压同一台 20GB 服务器。若要完全禁止 20GB 主机触碰远端混元贴图，可显式设置 `COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED=false`，此时系统会直接复用稳定 GLB 生成本地轻量贴图 fallback。

若长任务末段连续 3 次无法读取 history 与 queue，任务会保留 `prompt_id` 并转为可续接状态，避免网页无限等待或误触发第二次重建模。每个自部署重任务结束后，API 默认调用 ComfyUI `/free` 并等待远端队列 drain，再释放本地串行 slot；这样可以减少“上一轮 Python 还没完全退出，下一轮又提交”的堆叠风险。长时间运行时，本地会压缩 workflow job、job event 与 ComfyUI history 缓存；带 `prompt_id` 的自部署失败任务会优先保留，方便诊断或续接。

`server.mjs` 会自动读取 `.env.local` 与 `.env`。正式部署时建议由进程管理器、容器平台或服务器环境变量注入，不建议把密钥写进镜像、Markdown 或 Git。

## 本地启动

```bash
npm --prefix app install
npm run dev:api
npm run dev:app -- --port 5173
```

打开：

```text
http://127.0.0.1:5173/#workbench
```

如果通过 SSH 转发访问服务器：

```bash
ssh -p 9090 kk@47.242.195.8 -L 18188:127.0.0.1:8188
COMFYUI_BASE_URL=http://127.0.0.1:18188 npm run dev:api
```

## 工作台接口

健康检查：

```bash
curl http://127.0.0.1:8791/api/health
curl 'http://127.0.0.1:8791/api/providers/status?check=1'
```

Prompt 预览，不生成图片：

```bash
curl -X POST http://127.0.0.1:8791/api/references/prompt-preview \
  -H 'Content-Type: application/json' \
  --data '{"prompt":"线粒体","template":"auto"}'
```

生成单张参考图：

```bash
curl -X POST http://127.0.0.1:8791/api/references/text-to-image \
  -H 'Content-Type: application/json' \
  --data '{"prompt":"线粒体开放剖面 3D 教学模型","template":"auto","provider":"local-gateway"}'
```

上传参考图：

```bash
curl -X POST \
  'http://127.0.0.1:8791/api/references/upload?fileName=plant-cell.jpg&prompt=植物细胞%203D%20教学模型&template=plant-cell' \
  -H 'Content-Type: image/jpeg' \
  --data-binary @app/public/images/plant-cell.jpg
```

确认图生 3D：

```bash
curl -X POST http://127.0.0.1:8791/api/workflows/text-to-cell \
  -H 'Content-Type: application/json' \
  --data '{
    "prompt": "线粒体开放剖面 3D 教学模型",
    "template": "mitochondrion",
    "imageProvider": "local-gateway",
    "provider": "selfhost-triposg",
    "referenceId": "ref-xxx"
  }'
```

查询任务：

```bash
curl http://127.0.0.1:8791/api/jobs/job-xxx
```

完整默认链路可直接调用：

```bash
curl -X POST http://127.0.0.1:8791/api/workflows/full-text-to-3d \
  -H 'Content-Type: application/json' \
  --data '{
    "prompt": "线粒体",
    "template": "auto",
    "imageProvider": "local-gateway",
    "provider": "selfhost-triposg"
  }'
```

## 固定命令

调试 prompt：

```bash
python3 /Users/Apple/Downloads/苏增烨申请/deploy_3d/api_examples/build_bio_3d_ready_prompt.py 线粒体 --format prompt
```

跑单图 3D 生成：

```bash
python3 /Users/Apple/Downloads/苏增烨申请/deploy_3d/api_examples/run_bio_single_image_workflow.py \
  path/to/3d-ready-single-reference.png \
  --base-url http://47.242.195.8:8010 \
  --prefix bio_single_mitochondrion \
  --output-dir tripo-bio-benchmark/generated/mitochondrion
```

演示前检查：

```bash
/Users/Apple/Downloads/苏增烨申请/deploy_3d/local_tools/start_final_single_preview.sh
python3 /Users/Apple/Downloads/苏增烨申请/deploy_3d/api_examples/verify_bio_3d_workflow.py
```

工作台无扣费冒烟测试：

```bash
npm run dev:api
npm run smoke:workflow -- 线粒体开放剖面 3D 教学模型
```

本地图片网关文生图 + 本地缓存 3D 冒烟测试：

```bash
SMOKE_LIVE_IMAGE_GATEWAY=1 SMOKE_FULL_WORKFLOW=1 SMOKE_IMAGE_PROVIDER=local-gateway \
  npm run smoke:workflow -- 线粒体开放剖面 3D 教学模型
```

真实文生图 + 真实图生 3D 冒烟测试：

```bash
SMOKE_LIVE_IMAGE_GATEWAY=1 SMOKE_LIVE_3D=1 SMOKE_FULL_WORKFLOW=1 SMOKE_IMAGE_PROVIDER=local-gateway \
  npm run smoke:workflow -- 线粒体开放剖面 3D 教学模型
```

`SMOKE_LIVE_IMAGE_GATEWAY=1` 会调用本地图片网关生成参考图，`SMOKE_LIVE_3D=1` 会提交 ComfyUI/TripoSG/Bio3D 任务，可能产生模型服务成本与排队时间。默认不打开这两个开关，避免开发期间反复扣费。

## 运行目录

- `.reference-work/`：参考图写入过程目录。
- `.reference-cache/`：校验通过后的参考图。
- `.reference-trash/`：失败或待清理的参考图临时文件。
- `.generated-models/`：下载后的 GLB/GLTF 模型缓存。
- `.workflow-store/`：任务、参考图 metadata、ComfyUI history 与埋点事件。

这些目录都已加入 `.gitignore`，不会进入版本库。

## 验收口径

- 左侧生成工坊可以输入术语或课堂描述。
- `预览 Prompt` 能返回英文 3D-ready 单图 prompt。
- `生成参考图` 能产出单张参考图并写入 `.reference-cache/`。
- `接收图片` 后点击 `确认建模`，任务进入 `.workflow-store/jobs.json`。
- 自托管链路完成后，后端把 final GLB 写入 `.generated-models/`；若后处理失败但 raw GLB 已存在，系统会优先恢复 raw GLB 入库，避免任务停留在“未完成”。
- 前端收到 `job.result.modelUrl` 后自动加入底部标本索引，并加载到 3D 舞台。
- 刷新页面后，已完成任务能从 `/api/jobs` 恢复进标本索引。
- 失败时 API 返回明确阶段，例如 OpenAI 未配置、ComfyUI 不在线、无 GLB 输出、GLB 文件头异常。

## 排查要点

- OpenAI 参考图失败：先用 `/api/references/prompt-preview` 检查 `imagePrompt`，确认 prompt 是否符合单主体、开放剖面、半哑光、无文字标签。
- ComfyUI 连接失败：先执行 `curl --noproxy '*' $COMFYUI_BASE_URL/system_stats`，确认代理没有干扰。
- 3D 输出为空：检查 `.workflow-store/comfyui-*.json`，确认 history 中是否包含 `.glb` 路径。
- 几何错误：优先看 raw GLB，再修改参考图 prompt。
- 贴图增强：Hunyuan3D-Paint 默认作为低内存受控增强步骤运行；它复用已完成的 raw GLB，不重跑 TripoSG。若运行中 RAM 跌破 5.5GB 或 VRAM 跌破 8GB 硬熔断线，系统会中断贴图并嵌入确认参考图生成本地轻量贴图 fallback，保证图生 3D 入库不断链。同一 raw mesh 连续 2 次运行熔断后，默认退避约 3 小时，避免长时间压榨 20GB 服务器。

## 贴图稳定性复测

要确认“白模 -> 贴图后处理 -> 非白模彩色 GLB”在当前服务器上可复现，可先保留一个已完成的 selfhost raw GLB，然后运行：

```bash
npm run smoke:texture-artifacts
npm run smoke:texture-stability -- --runs=3 --timeout-minutes=80 --cooldown-ms=20000 --drain-timeout-ms=180000 --min-ram-recovery-gib=16.5
```

`smoke:texture-artifacts` 是无重任务检查：只读取 `.workflow-store/jobs.json` 中最近的 selfhost 贴图结果，下载现有 GLB，按 active material 口径确认 mesh 实际使用的材质是否有嵌入 texture 或非白 baseColor，不会提交新的远端 Hunyuan3D-Paint 任务。资源空闲且需要复测连续稳定性时，再运行 `smoke:texture-stability`。

脚本会复用最近的 raw GLB，串行调用 `/api/jobs/:id/texture-enhance`，检查远端队列、RAM/VRAM、安全 drain、GLB JSON 中的 texture/material 信号，并优先判断 mesh 实际使用的 active material 是否带 texture 或非白 baseColor，避免旧材质残留造成“看起来没贴图”的误判。报告会写入 `.workflow-store/texture-stability-*.json` 与 `.workflow-store/texture-stability-latest.json`。

最近一次实机报告结果为：3/3 完成、3/3 彩色 fallback、0 失败；新的检查口径要求 active material 可见有色或带嵌入 texture。这个结果说明，在当前 20GB 主机上，原生 Hunyuan3D-Paint 会进入受控试跑但仍可能把 RAM 压到危险区；稳定可复现的生产路径是“受控 Hunyuan 尝试 -> 运行熔断/退避 -> Bio3D 轻量贴图 fallback -> 非白模彩色 GLB”。若要稳定获得原生 Hunyuan 贴图而不是 fallback 贴图，需要更高系统内存或继续优化远端 Hunyuan 节点级 offload/贴图尺寸。
