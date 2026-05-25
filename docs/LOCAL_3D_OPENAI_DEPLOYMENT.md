# 本地 3D 生成与 GPT 文生图部署说明

## 目标链路

```text
用户输入文本 / 上传图片
  -> 后端生成或缓存参考图
  -> 用户确认参考图
  -> 本地 ComfyUI 图生 3D
  -> 下载 textured GLB
  -> 前端 3D 舞台展示
```

当前实现按 `deploy_3d/BIO_3D_FINAL_HANDOFF.md` 收敛后的路线接入：

- OpenAI GPT Image 生成单张 3D-ready 参考图。
- ComfyUI 使用单图 workflow：`LoadImage -> TripoSGImageTo3D -> Hunyuan3DPaintExistingMesh -> Preview3D`。
- 前端默认展示 `textured.glb`，必要时可保留 `raw.glb` 做几何诊断。

## 环境变量

复制 `.env.example` 中的配置到本地运行环境。核心项如下：

```bash
OPENAI_API_KEY=sk-...
OPENAI_IMAGE_MODEL=gpt-image-1.5
COMFYUI_BASE_URL=http://47.242.195.8:8010
COMFYUI_WORKFLOW_TEMPLATE=server/workflows/bio_single_image_triposg_hy3dpaint_api.json
```

如果通过 SSH 转发访问服务器：

```bash
ssh -p 9090 kk@47.242.195.8 -L 18188:127.0.0.1:8188
COMFYUI_BASE_URL=http://127.0.0.1:18188 npm run dev:api
```

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

## 接口检查

健康检查：

```bash
curl http://127.0.0.1:8791/api/health
curl http://127.0.0.1:8791/api/providers/status
```

OpenAI 未配置时，`/api/references/text-to-image` 会返回缺少 `OPENAI_API_KEY` 的明确提示，并附带后端扩写后的 3D-ready prompt，方便先检查 prompt 质量。

上传参考图：

```bash
curl -X POST \
  'http://127.0.0.1:8791/api/references/upload?fileName=plant-cell.jpg&prompt=植物细胞%203D%20教学模型&template=plant-cell' \
  -H 'Content-Type: image/jpeg' \
  --data-binary @app/public/images/plant-cell.jpg
```

用确认后的 `reference.id` 创建建模任务：

```bash
curl -X POST http://127.0.0.1:8791/api/workflows/text-to-cell \
  -H 'Content-Type: application/json' \
  --data '{
    "prompt": "植物细胞 3D 教学模型",
    "template": "plant-cell",
    "imageProvider": "openai",
    "provider": "selfhost-triposg",
    "referenceId": "ref-xxx"
  }'
```

查询任务：

```bash
curl http://127.0.0.1:8791/api/jobs/job-xxx
```

## 运行目录

- `.reference-work/`：参考图写入过程目录。
- `.reference-cache/`：校验通过后的参考图。
- `.reference-trash/`：失败或待清理的参考图临时文件。
- `.generated-models/`：下载后的 GLB/GLTF 模型缓存。
- `.workflow-store/`：任务、参考图 metadata、ComfyUI history 与埋点事件。

这些目录都已加入 `.gitignore`，不会进入版本库。

## 排查要点

- OpenAI 参考图失败：先看 `/api/references/text-to-image` 返回的 `detail.imagePrompt`，确认 prompt 是否符合单主体、开放剖面、半哑光、无文字标签。
- ComfyUI 连接失败：先执行 `curl --noproxy '*' $COMFYUI_BASE_URL/system_stats`，确认代理没有干扰。
- 3D 输出为空：检查 `.workflow-store/comfyui-*.json`，确认 history 中是否包含 `.glb` 路径。
- 几何错误：优先看 raw GLB，再修改参考图 prompt。
- 贴图错误：优先看 textured GLB 的材质和贴图输出，再调整 Hunyuan3D-Paint 或参考图材质。
