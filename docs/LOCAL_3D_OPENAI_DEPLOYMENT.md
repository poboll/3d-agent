# 间 MA 工作台：本地 3D 生成与 GPT 文生图部署说明

## 目标链路

```text
用户输入术语 / 课堂描述 / 上传图片
  -> 后端打磨 3D-ready 单图 prompt
  -> 本地图片网关 / GPT Image 生成单张参考图，或缓存用户上传图片
  -> 用户确认参考图
  -> ComfyUI 单图工作流
  -> TripoSG 输出 raw.glb
  -> Hunyuan3D-Paint 输出 textured.glb
  -> 后端下载并缓存 GLB
  -> 前端 3D 舞台展示 textured.glb
```

当前实现按 `/Users/Apple/Downloads/苏增烨申请/deploy_3d/BIO_3D_FINAL_HANDOFF.md` 收敛后的路线接入：

- gpt-5.5 使用 Responses API 打磨 3D-ready prompt，并优先通过本地图片网关生成单张参考图。
- ComfyUI 使用单图 workflow：`LoadImage -> TripoSGImageTo3D -> Hunyuan3DPaintExistingMesh -> Preview3D`。
- 前端默认展示 `textured.glb`，必要时可保留 `raw.glb` 做几何诊断。
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
OPENAI_IMAGE_SIZE=1024x1024
OPENAI_IMAGE_QUALITY=medium
OPENAI_IMAGE_FORMAT=png

LOCAL_IMAGE_GATEWAY_BASE_URL=http://127.0.0.1:48760
LOCAL_IMAGE_GATEWAY_API_KEY=<填写本地图片网关 API Key>
LOCAL_IMAGE_GATEWAY_PROMPT_MODEL=gpt-5.5
LOCAL_IMAGE_GATEWAY_IMAGE_MODEL=gpt-image-2
LOCAL_IMAGE_GATEWAY_IMAGE_MODEL_FALLBACKS=gpt-image-2,gpt-image-1.5,gpt-image-1
LOCAL_IMAGE_GATEWAY_REASONING_EFFORT=xhigh
LOCAL_IMAGE_GATEWAY_DISABLE_RESPONSE_STORAGE=true
LOCAL_IMAGE_GATEWAY_IMAGE_SIZE=1024x1024
LOCAL_IMAGE_GATEWAY_IMAGE_QUALITY=medium
LOCAL_IMAGE_GATEWAY_IMAGE_FORMAT=png
DEFAULT_IMAGE_PROVIDER=local-gateway
```

三维生成服务使用本地/自托管 ComfyUI：

```bash
COMFYUI_BASE_URL=http://47.242.195.8:8010
COMFYUI_WORKFLOW_TEMPLATE=server/workflows/bio_single_image_triposg_hy3dpaint_api.json
COMFYUI_STEPS=30
COMFYUI_FACES=30000
COMFYUI_GUIDANCE_SCALE=7
COMFYUI_TIMEOUT_MS=7200000
COMFYUI_POLL_INTERVAL_MS=15000
```

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

`SMOKE_LIVE_IMAGE_GATEWAY=1` 会调用本地图片网关生成参考图，`SMOKE_LIVE_3D=1` 会提交 ComfyUI/TripoSG/Hunyuan3D-Paint 任务，可能产生模型服务成本与排队时间。默认不打开这两个开关，避免开发期间反复扣费。

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
- 自托管链路完成后，后端把 textured GLB 写入 `.generated-models/`。
- 前端收到 `job.result.modelUrl` 后自动加入底部标本索引，并加载到 3D 舞台。
- 刷新页面后，已完成任务能从 `/api/jobs` 恢复进标本索引。
- 失败时 API 返回明确阶段，例如 OpenAI 未配置、ComfyUI 不在线、无 GLB 输出、GLB 文件头异常。

## 排查要点

- OpenAI 参考图失败：先用 `/api/references/prompt-preview` 检查 `imagePrompt`，确认 prompt 是否符合单主体、开放剖面、半哑光、无文字标签。
- ComfyUI 连接失败：先执行 `curl --noproxy '*' $COMFYUI_BASE_URL/system_stats`，确认代理没有干扰。
- 3D 输出为空：检查 `.workflow-store/comfyui-*.json`，确认 history 中是否包含 `.glb` 路径。
- 几何错误：优先看 raw GLB，再修改参考图 prompt。
- 贴图错误：优先看 textured GLB 的材质和贴图输出，再调整 Hunyuan3D-Paint 或参考图材质。
