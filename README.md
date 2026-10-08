# SplatApp —— 本地一键把视频 / 图片变成可交互 3D 高斯泼溅

把 ooosplat 的 `splatstudio` 命令行引擎包成 **HTTP API + 极简网页前端**：素材进去、`final.ply` 出来，
浏览器里直接实时预览。后端与前端**完全解耦**，前端只调用 `/api/*`，可以整体替换成自己的前端。

```
素材(视频 / 图片 zip)  →  SplatApp 后端  →  splatstudio 引擎  →  final.ply  →  网页 3D 实时预览
```

- 后端：纯 Python 标准库（无 pip 依赖），`server.py`
- 前端：素材 / 预览 / 进度，加上可收起侧栏的展示模式，`web/`
- 渲染：原版 SuperSplat Viewer 1.36.2（内置 PlayCanvas 2.22.6），固定版本本地保存，**离线可用**

### 项目特点

- **零依赖后端**：`server.py` 只用 Python 标准库，没有 pip、框架和数据库；`web/` 之外的目录都是运行时数据。
- **工程细节而非 demo 拼装**：素材按 sha256 内容寻址去重（硬链接引用）、单任务 FIFO 队列、
  CPU / GPU 双入口共享 GPU 进程锁、失败任务保留完整素材可重试、启动对账 + 派生数据自动回收 +
  任务数 / 磁盘配额淘汰。详见「磁盘占用策略」。
- **查看器专门调过**：本地固定版本 SuperSplat Viewer，强制 WebGL2 并开启高斯抗锯齿，规避默认 WebGPU
  路径的排序闪烁；自研 8 种粒子形变、多模式相机无缝交接、按模型保存水平面与默认视角（IndexedDB）。
- **可验证**：后端 unittest + Node 前端交互回归，GPU 像素级验证页输出逐项结果与 JSON 报告。

### 前置条件

| 依赖 | 说明 |
|---|---|
| Python 3.11+ | 仅标准库；服务端与质量配置脚本 |
| OOOSplat 引擎 | **不在本仓库**。需要放在本目录的兄弟目录 `ooosplat-test/`，提供 `run-ooo.sh`（`splatstudio` + 免 root 的 ffmpeg / COLMAP / Brush）。`/api/health` 的 `runOoo` 字段反映其可达性 |
| CUDA 版 COLMAP | 仅 GPU 入口（`start-gpu.sh`）需要，默认从 `../gpu-build/colmap-install/bin/colmap` 读取，可用 `SPLAT_COLMAP_REAL` 覆盖；CPU 入口只需引擎自带的 COLMAP |
| Node.js | 仅用于 `.cjs` 前端交互测试，运行服务不需要 |
| NVIDIA GPU | 建议 ≥ 8 GB 显存；实际峰值约 2.4 GiB（RTX 5060 Laptop 8 GB 实测） |

查看器明确使用 WebGL2，并开启高斯抗锯齿以降低移动时细节的亮度跳变；统一
HTTPS 云端与本地入口的渲染后端，避免默认
WebGPU 路径带来的设备兼容性与高斯排序闪烁。高斯排序在 CPU Worker 中执行，
绘制仍使用 GPU；大型模型的排序速度可能低于 WebGPU。
2026-10-02 的发布和验证记录见 [渲染闪烁处理](docs/render-flicker-20261002.md)。

### 精细档质量配置（2026-10-02）

精细档保留引擎请求的 **30,000 步**和训练分辨率上限，不再默认缩减为
12,000 步 / 1,440 长边。实际图像仍不会被放大。

- 精细档匹配开启 COLMAP 3.9 的 guided matching；视频相邻匹配窗口从 10 扩大到 20。
  特征提取和匹配最多使用 8 个 CPU 线程。快速、均衡档沿用原参数。
- 精细档训练前调用 COLMAP `image_undistorter`，同时校正图像和相机参数，避免
  Brush 0.3 忽略 `SIMPLE_RADIAL` 等镜头畸变。原始素材与稀疏重建保留原样。
  透明 PNG / MOV 提取的 RGBA PNG 保留原透明训练路径，暂不执行会丢失 Alpha 的 RGB 去畸变。
- Brush 显存独立通过 `nvidia-smi` 检测，不依赖 CPU 版 COLMAP 的 CUDA 支持。
  单 NVIDIA GPU、原上限为 20 万且未进入 OOM 紧急回退时：
  总显存 ≥ 8,000 MiB 且空闲 ≥ 4,000 MiB，使用 60 万上限；
  ≥ 12,000 / 8,000 MiB 时使用 150 万；≥ 24,000 / 16,000 MiB 时使用 400 万。
  这是容量上限，不保证最终高斯数量。检测失败、设备不明确或空闲显存不足时保留原上限。
- 引擎的 OOM 紧急回退保留低分辨率和保守上限，不会被包装脚本再次调高。
- 修复 Brush 0.3 对小于 16,387 字节 JPEG/PNG 的载入兼容性：仅为生成的训练副本
  添加文件尾部填充，不改变像素，先断开硬链接，不修改原图或原始素材。
- 实际训练配置保存在 `projects/<id>/logs/quality-training.json`；最后一次 COLMAP
  重建尝试诊断保存在 `logs/quality-reconstruction.json`，包含注册数量和低特征画面。
  两份报告在中间数据回收后保留，并通过任务 API 的 `qualityReport` 暴露。
  最终作品的注册数量以原 `stats` 为准。

可以显式设置 `SPLAT_HIGH_STEPS` / `SPLAT_HIGH_RES` / `SPLAT_HIGH_STOP` /
`SPLAT_HIGH_MAX_SPLATS` 覆盖参数；例如临时设置前两者为 `12000` / `1440` 可使用
旧的提速配置。现有作品不会自动重训，新提交的精细档任务使用新策略，耗时和显存占用会增加。
验证记录见 [质量改进记录](docs/quality-improvement-20261002.md)。

## 启动

本机推荐通过用户级服务管理器启动，关闭调试终端后仍可访问，异常退出会自动重启：

```bash
cd <仓库根目录>
bash start-service.sh cpu  # http://127.0.0.1:8848
bash start-service.sh gpu  # http://127.0.0.1:8850
```

脚本检测到已有服务时直接复用，不会重启正在生成的任务。服务独立于调用终端，
持续到显式停止或用户会话结束；重启电脑后重新执行脚本即可。日志可用
`journalctl --user -u splat-app-web.service` 或 `-u splat-app-gpu.service` 查看。
需要停止时使用 `systemctl --user stop splat-app-web.service`（GPU 为 `splat-app-gpu.service`）。
页面每秒同步所选任务，每 10 秒检测连接；读取超过 8 秒会取消请求再尝试，断线时保留已显示进度。

服务使用 `Restart=always`：意外正常退出和异常退出都会恢复；显式 `systemctl --user stop`
仍会停止。当前已安装的两条服务由 `services/10-reliability.conf` 对应的用户级 drop-in 增强。
`server.py` 输出即时 JSON 诊断：`server_started`、`shutdown_requested`（信号及未完成任务）、
`server_stopped`、5xx／超过 2 秒的 API 响应、未预期的请求异常。
健康接口的 `process` 提供 PID、实例 ID、启动时间、当前连接数和连接上限。
这些 Python 诊断在下次服务启动时加载；仅修改服务重启策略可 `daemon-reload`，无需停止任务。
2026-10-02 的断联调查记录见 [调查记录](docs/backend-disconnection-20261002.md)。

### CUDA 重建试用入口（2026-10-02）

本机新编译的 COLMAP 4.2.1 / CUDA 12.8 / SM 120 可以通过以下入口试用：

```bash
cd <仓库根目录>
bash start-gpu.sh
# 打开 http://127.0.0.1:8850
```

该入口使用独立的 `data-gpu/` 和 `work-gpu/`。原 `python3 server.py` 仍使用
8848 端口与旧引擎。当前只启用 GPU SIFT 提取和匹配，Mapper 沿用 CPU 优化。
适配器将 3.9 参数转换为 4.x 参数，并独立请求 GPU，绕过上游 Linux CUDA
运行时检测的误判；提取使用一个线程，匹配保留最多八个 CPU 几何验证线程。
实际 GPU 初始化证据和阶段耗时写入项目 `logs/quality-colmap.json`，任务 API
通过 `qualityReport.colmap` 返回；上游 `splatstudio health` 的 CPU 判定仍不准确。
不要把其原始 health 判定当作实际 GPU 执行结果。

验证记录与限制见 [GPU 接入记录](docs/gpu-reconstruction-20261002.md)。

### 原 CPU 入口

```bash
cd <仓库根目录>
python3 server.py                 # 默认 http://127.0.0.1:8848（仅本机）
# 其他端口： python3 server.py --port 9000
# 局域网/容器里对外： python3 server.py --host 0.0.0.0
# 保留中间数据： python3 server.py --keep-work
# 连 source/ 素材副本也不留： python3 server.py --prune-source
# 配额： python3 server.py --max-jobs 20 --max-data-gb 50
```

### 磁盘占用策略

任务派生数据自动回收；失败任务保留完整原素材供重试：

| 位置 | 完成时 | 失败/中断时 |
|---|---|---|
| `projects/<id>/final.ply` | 保留 | 删除 |
| `projects/<id>/project.json` `state.json` `logs/` | 保留 | 保留（保留失败原因） |
| `projects/<id>/work/` | **删除**（`--keep-work` 可留） | 删除 |
| `projects/<id>/source/` | 保留（`--prune-source` 可删） | 删除 |
| `data/uploads/<jid>/` | 删除（项目内已有素材副本） | 保留完整输入供重试；不完整的上传删除 |

补充机制：

- **内容去重**：上传素材按 sha256 存到 `data/blobs/<前两位>/`，项目内用**硬链接**引用。
  同一段视频重复提交只占一份磁盘（实测同一素材提交 3 次，原本各留一份 156 MB）。
  任务完成后 `source/` 里的副本会按内容哈希换回硬链接，去重不会因素材副本而失效。
- **启动去重**：启动时扫描 `projects/*/source/` 与 `uploads/`，把内容相同的素材副本收敛成
  同一个 blob（只读目录自动跳过）；历史遗留的重复拷贝不用手工处理。
- **上传防线**：`Content-Length` 非法、实收字节少于声明（截断）都会直接失败并清掉中转文件；
  单次上传上限 4 GiB；zip 另限条目数、单条解压体积与整包解压总量（见「已知限制」）。
- **崩溃兜底**：`splatstudio` 只在结尾输出项目路径，任务被杀时服务端拿不到；
  服务端按目录名 `<时间戳>_<输入主名>` 归属关系认领新建目录，再走回收。
  启动时还会对账所有**无任务引用**的项目目录，回收其中的派生数据（保留元数据）。
- **启动对账**：每次启动按上表策略清扫既有任务——清终态任务的 `work/` 与
  已完成任务的 `uploads/` 中转目录（仅当项目内确有素材副本时）；失败任务保留完整输入。保留策略对历史任务同样生效，
  升级后无需手工清理旧数据。
- **停止服务**：Ctrl-C / SIGTERM 会把运行中任务标记失败、杀掉引擎整个**进程组**（含它派生的
  子进程），并回收派生数据；退出前会等正在写盘的请求收尾。
- **配额**：`--max-jobs`（默认 20）与 `--max-data-gb`（默认 50）超出后从最旧的
  已完成/失败任务开始淘汰；运行中任务绝不淘汰。

浏览器打开 `http://127.0.0.1:8848`。左上角「后端就绪」表示 `run-ooo.sh` 可达。

**前置条件**：`../ooosplat-test/` 必须存在（后端会调用 `../ooosplat-test/run-ooo.sh`）。
`/api/health` 会返回 `runOoo: true/false`，前端据此显示状态。

## 使用

生成任务采用单任务 FIFO 队列：上传完成后入队，前一个任务结束并完成清理后，
下一个任务自动开始。页面显示「排队中」、当前入口中的排队位置和等待时间；
开始运行后再计生成耗时。失败任务也会让出位置，继续处理后续任务。

左侧「生成任务」列出当前入口保留的全部任务，包括排队、生成中、已完成和失败，
每 3 秒刷新；点击任务可切换查看进度、日志或结果。同名素材用提交时间和任务 ID 区分。
展示模式下点击顶部「生成任务」可展开列表。直接打开页面时自动选中运行中的任务。
所选任务每秒轮询，百分比保留两位小数且不会被阶段起点的普通日志拉低；训练估算进度
仍按引擎报告显示，不代表实际训练步数。「作品库」保留已完成模型和本地 PLY。

失败任务卡片和进度面板提供「重试」：沿用原质量档位，从头生成一个新任务并保留旧记录。
完整原素材仍在时直接入队；旧版本已清理的素材需要重新选择文件。重复点击不会重复入队。
新尝试通过 `retryOf` 关联旧任务。失败素材受任务数量与磁盘配额限制，删除或淘汰任务时回收。

CPU（8848）和 GPU（8850）入口共用项目根目录下的 `.gpu-pipeline.lock` 进程锁，
整个重建、训练和清理期间都持有锁，避免两个入口同时使用同一张显卡。
每个入口内部按入队顺序运行；跨入口只保证互斥，不保证全局 FIFO。
锁文件不能在服务运行时删除；进程退出或崩溃后，系统自动释放锁。
这项限制适用于本项目网页服务启动的任务，外部手工运行的 Brush 不在队列内。
服务停止或重启时，未完成任务会标记为中断失败；完整输入保留，可用「重试」重新入队。

1. 选素材：MP4 / MOV 视频，或图片集的 `.zip`（zip 内为 png/jpg）。
2. 选质量档位：`fast` / `balanced` / `high`。
3. 点「开始生成」，页面实时显示阶段、百分比、引擎原始日志。
4. 完成后自动加载 `final.ply` 并进入展示模式；使用原版 SuperSplat 的工具栏和交互。
5. 「下载 final.ply」。
6. 也可导入本地 `.ply`，或在「作品库」点击已完成作品卡片，无需重新生成。

### 原版 SuperSplat 预览

左侧导入区或预览底部「导入 PLY」支持本地 `.ply`；文件通过 blob URL
在浏览器中加载，不上传、不创建任务。后端生成结果直接使用 `/api/artifact`。
两者均明确传入 PLY 文件名，避免无后缀 URL 选错解析器。

- 原版环绕 / 飞行模式、旋转 / 平移 / 缩放、点击定位、触摸手势。
- 原版动画播放 / 暂停 / 时间轴、操作说明、信息面板、性能模式、适应、重置与全屏。
  环绕、飞行模式的快捷键以原版操作提示为准。
- 新增并列的「原有视角」模式：复用原来的 OrbitControls 手感，左键旋转、右键平移、
  中键拖动或滚轮缩放，中键单击通过真实模型深度定位旋转中心。
  WASD 平移，Shift+WASD 旋转；0/1 源视角、2 正面、3 左侧、4 右侧、5 俯视、6 背面。
  U 辅助水平面，←/→ 调平，Shift+U 保存默认水平面；按钮可恢复默认水平面。
  辅助平面固定在模型坐标中，左右或斜向平移、重新定位旋转中心都不会拖动平面。
  R 自动环绕、O 正交/透视、I 相机信息、F 全屏；支持松手回正和鼠标视差开关。
  再次点击「原有视角」、标题栏「退出原有视角」或 Esc 返回环绕相机；
  全屏时 Esc 先退出全屏，再按一次退出原有模式。退出清除自动进入该模式的偏好。
  三种模式交接当前相机位置、方向、调平角度与视野角，切换不再跳回旧机位。
  Shift+U 按模型保存水平面；「保存默认视角」保存当前机位，「恢复默认视角」重新应用。
  同一作品重新打开可恢复，不同作品互不影响。旧全局水平面仅迁移到首次打开的模型。
  本地文件以名称、大小、修改时间识别；同一文件修改后视为新的模型。
  原有正交模式返回环绕/飞行时转换为保持机位和画面尺度的透视投影。
- 普通 PLY 打开时停在初始机位；点原版播放按钮可启动自动环绕动画。
- 原版行走模式仅在有碰撞数据且场景适合行走时显示；普通 PLY 不伪造碰撞。
- 点页头「进入展示模式」收起素材和进度；「展开素材与进度」恢复生成控制。
  打开模型会自动进入展示模式，全屏使用原版查看器的按钮。
- 「作品库」用真实模型封面卡片列出完成的任务，支持名称搜索和一键展示。
  「添加作品」可一次导入多个 PLY，解码成功后将模型保存在当前浏览器 IndexedDB，刷新可继续展示。
  本地作品链接为 `?work=<id>`；清除浏览器站点数据会移除这些本地作品。
  卡片「删除」先显示确认：本地作品删除浏览器中的副本；生成作品删除后端任务、模型及其保存素材。
  删除当前展示的作品会释放预览并清空下载入口，删除失败保留卡片供重试。
  首次打开作品库时串行生成缺失封面，保存在浏览器 IndexedDB；关闭作品库或切换作品立即取消。
  保存默认视角会更新该作品封面。切换时更新 `?job=<id>`，刷新可恢复该任务。
  本地导入会清除旧任务链接和下载入口，避免刷新后显示错误的后端模型。
- 宿主输入框与下拉框获得焦点时暂停查看器的窗口级键盘输入，点击画布后恢复。
- Brush PLY 的远处飞点会把原始 AABB 拉得很大。适配层从解码的位置数据抽样计算
  1%–99% 分位范围，供原版初始取景 / 适应 / 重置使用；不改写或删除任何高斯数据。
- 模型切换会取消旧下载、销毁原版实例并释放 blob URL。损坏 PLY 显示明确错误，
  可以继续导入；不把解析失败当成成功。

原版依赖、许可证与校验值见 [SuperSplat 来源](web/vendor/supersplat/SOURCES.md)。
迁移前的页面保存在 `artifacts/pre-supersplat/`；Spark、粒子特效源码和旧验证页保留作参考，
原有视角复用本地 Three.js 与 OrbitControls；粒子特效由 `web/particle-effects.js` 在同一
PlayCanvas 渲染器内实现，不加载第二套 Spark 渲染器。作品封面生成使用临时原生实例，逐个释放。
官方原始运行时保持在 `index.js`，当前加载 `host-viewer.js`；生成脚本只开放相机快照接口，
保留环绕/飞行的 FOV 和飞行倾斜，避免模式过渡清零水平面，详见来源说明。

### 粒子特效

左上角「粒子特效」提供总开关、模式、强度、范围与叠加微动。
支持局部排斥、吸附、流动、拖拽甩动、高度扭转、局部涡旋、呼吸、空间扰动，
以及点击爆散、点击波纹；按钮也可从模型中心触发脉冲。
鼠标使用原生 GPU 深度定位，点击和拖动分别识别。X 恢复形变默认值，P 切换点云，−/+ 调整粒子尺寸。
关闭后还原未形变粒子，重新开启保留参数。静止时停止工作缓冲更新；动态形变发生在原生排序前。
旧 C 光标 / G 焦距开关仍属于历史 Spark 功能。
适配入口为 `web/supersplat-preview.js`，原有视角实现为 `web/legacy-view-controls.js`。

## 本机实测基线（RTX 5060 Laptop / 8 GB 显存 / 32 核 / 31 GB RAM）

| 素材 | 档位 | 耗时 | Splat 数 | PLY 大小 | 注册 |
|---|---|---|---|---|---|
| 60 张图片 | fast | 7 分 49 秒 | 824,366 | 194.5 MB | 60/60 |
| 20 秒视频（600 帧） | fast | 11 分 12 秒 | 1,147,653 | 270.8 MB | 120/120 |
| 2 秒视频（60 帧，冒烟用） | fast | 5 分 2 秒 | 288,957 | 69.1 MB | 30/30 |
| 手机实拍视频（101 帧） | fast | 8 分 30 秒 | 44,421 | 10.5 MB | 101/101 |
| 手机实拍视频（66 帧） | fast | 3 分 44 秒 | 15,798 | 3.7 MB | 54/66 |

> 引擎自报耗时（`预计约 00:02:34`）会低估 2.5–3 倍，界面显示的是**真实墙钟时间**。

### 素材建议与注意

- 素材质量决定成败：**环绕拍摄、画面清晰、光照稳定、少运动模糊**。快速甩动或纯平移会掉注册率。
- 显存口径 8151 MiB，实测峰值约 2.4 GiB；生成时**关掉其他吃显存的程序**（浏览器硬件加速、其他 3D 应用）。
- 视频帧率高≠更好：`balanced`/`high` 会抽更多帧，耗时与显存同步上升。演示优先 `fast`。
- 视频路径必须为绝对路径（引擎已知 bug：相对路径会被解析成 `media/media/xxx`）。**后端已全部传绝对路径。**

## 后端 API 契约

所有响应均为 JSON（除文件流），已开 CORS `Access-Control-Allow-Origin: *`；
预检 `OPTIONS` 放行 `Content-Type` 与 `X-Filename` 两个请求头。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，包含 `queue: {maxConcurrent: 1, waiting, running}`；计数为当前入口 |
| POST | `/api/jobs?quality=fast` | 上传素材并创建任务。body 为**原始文件字节**，文件名走 `X-Filename` 头（URL 编码）。返回 202 + 任务对象 |
| POST | `/api/jobs/retry?id=<jid>` | 重试失败任务，沿用原质量；空 body 复用保留输入，原始文件 body + `X-Filename` 可补交已清理的素材。返回 202 新任务（`retryOf`）；缺素材返回 409 + `sourceMissing`，已有活跃重试返回 409 + `retryJobId` |
| GET | `/api/jobs` | 列出全部任务（不含日志） |
| GET | `/api/job?id=<jid>` | 单个任务完整状态（含 `log` 末 400 行） |
| GET | `/api/artifact?id=<jid>` | `final.ply` 原始字节流，**支持 Range / 206**，供渲染库分段加载 |
| GET | `/api/download?id=<jid>` | 同上，但带 `Content-Disposition: attachment`，用于下载 |
| DELETE | `/api/jobs?id=<jid>` | 删除任务记录及其全部派生数据（项目目录一并清除）。运行中/排队中返回 409，未知 id 返回 404 |

### 任务对象字段

```jsonc
{
  "id": "fa4c32c38115",
  "filename": "orbit.mp4",       // 上传文件名
  "quality": "fast",
  "status": "queued|running|done|failed",
  "queuePosition": null,        // 排队时为当前入口中的 1-based 位置；其余为 null
  "queuedAt": 1759300000.0,     // 上传完成、进入队列的时间
  "stage": "TrainingSplats",     // 引擎阶段名
  "stageLabel": "高斯训练",       // 中文标签
  "percent": 62.5,               // 引擎进度百分比
  "message": "Brush 训练中 · 估算进度 12%",
  "log": ["..."],                // 原始日志行（末 400 行）
  "createdAt": 1759300000.0,     // Unix 秒
  "startedAt": 1759300001.0,
  "finishedAt": null,            // 完成后为 Unix 秒
  "projectId": "20261001-110155_smoke",
  "projectPath": "/abs/path/data/projects/20261001-110155_smoke",  // 绝对路径
  "finalPly": "/abs/path/data/projects/.../final.ply",             // 绝对路径，完成后才有
  "inputPath": "/abs/path/data/uploads/<jid>/orbit.mp4",           // 实际喂给引擎的路径
  "returncode": 0,               // 引擎退出码（运行中为 null）
  "stats": {                     // 引擎末端 JSON 结果块，完成后才有
    "splatCount": 292691, "fileSize": 69076627, "inputImages": 30,
    "registeredImages": 30, "registeredRatio": 1.0, "points3d": 8534,
    "durationMs": 319500, "completedAt": "...", "warning": null
  },
  "error": null                  // 失败原因
}
```

### 阶段（`stage` → `stageLabel`）

`Created` 创建任务 · `ProbingVideo` 读取素材 · `PlanningFrames` 规划抽帧 · `ExtractingFrames` 抽取画面 ·
`ExtractingFeatures` 特征提取 · `Matching` 特征匹配 · `Reconstructing` 相机重建 ·
`ValidatingReconstruction` 校验重建 · `BridgeBackfill` 桥接补帧 · `TrainingSplats` 高斯训练 ·
`Exporting` 导出模型 · `Completed` 全部完成

### 自己写前端时的最小调用

```js
// 1) 提交素材
const res = await fetch('/api/jobs?quality=fast', {
  method: 'POST',
  headers: { 'X-Filename': encodeURIComponent(file.name) },  // 必须 URL 编码
  body: file,                                                // 原始字节
});
const job = await res.json();

// 2) 轮询进度
const cur = await (await fetch(`/api/job?id=${job.id}`)).json();
// cur.percent / cur.stageLabel / cur.message / cur.status

// 3) 加载模型（SuperSplatPreview 管理原版 Viewer 生命周期）
import { SuperSplatPreview } from './supersplat-preview.js';
const preview = new SuperSplatPreview({ rootElement: document.getElementById('viewer') });
await preview.load(`/api/artifact?id=${job.id}`, { filename: 'final.ply' });
```

## 目录结构

```
.                        # 仓库根目录
├── server.py              # 后端（标准库 HTTP 服务）
├── README.md
├── tests/                 # 后端无 GPU 回归（HTTP 层、上传、回收策略）
├── web/                   # 前端（可整体替换）
│   ├── index.html         # 演示入口与原版查看器样式
│   ├── style.css          # Kuromi 纸艺主题（背景插画 + 品牌 token）
│   ├── app.js             # 生成流程、作品列表与展示模式
│   ├── supersplat-preview.js # 原版 Viewer 的加载、取景与生命周期适配
│   ├── preview-layout.css # 展示布局，不改原版 UI
│   ├── spark-viewer.js    # Spark 渲染、OrbitControls、指针定位与生命周期
│   ├── splat-effects.js   # Spark Dyno 粒子形变
│   ├── tests/             # GPU 画面和交互回归验证
│   ├── assets/            # 背景插画（webp / jpg 双格式）
│   ├── fonts/             # 子集化手写体与 OFL 许可证
│   └── vendor/            # 本地化依赖、许可证、来源说明
│       ├── supersplat/    # 原版 SuperSplat Viewer 1.36.2 + PlayCanvas 2.22.6
│       ├── spark/         # 旧版参考：Three.js 0.180.0 + Spark 2.2.0
│       └── tweakpane/     # Tweakpane 4.0.5（粒子形变参数面板）
├── data/                  # 运行时生成，不入库（.gitignore）
│   ├── blobs/<sha[:2]>/   # 内容寻址素材池，任务目录用硬链接引用
│   ├── uploads/<jid>/     # 上传中转目录，任务成功后回收
│   ├── projects/          # 生成结果（final.ply 在这里）
│   └── jobs.json          # 任务持久化，重启可恢复
└── work/<jid>.log         # 每次生成的完整引擎日志
```

后端回归（无需 GPU、不碰现有任务数据，全部在临时目录里跑独立副本）：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
node tests/test_queue_ui.cjs
node tests/test_plane_anchor.cjs
```

## 视觉主题

整站向背景插画（Kuromi 水彩）靠拢：奶白纸面、暖棕文字、淡紫强调，3D 画布保持深色以看清高斯粒子，
用奶白描边做成画框。配色沿用 Kuromi 主题的品牌 token（`web/style.css` 的 `:root`），不另造色板。
背景插画与手写体标题字体都在本地 vendor：`web/assets/`（webp，不支持时回退 jpg）、`web/fonts/`（子集化
`StoryHand`，源 Ma Shan Zheng，SIL OFL 1.1）。来源与校验值见 [vendor/tweakpane/SOURCES.md](web/vendor/tweakpane/SOURCES.md)。

### 主题文件

主题 token 在 `web/style.css` 的 `:root`，展示布局在 `web/preview-layout.css`。
画布内 UI 以 `web/vendor/supersplat/index.css` 为基础，由 `web/viewer-theme.css` 统一为
奶油色纸面、棕色文字、紫色选中态、圆角描边与柔和阴影，沿用前端主题 token。
原有视角面板布局在 `web/legacy-view-controls.css`。窄屏工具栏自动换行，
打开设置时折叠原有视角控制，仍保留退出按钮；信息弹窗显示在控制面板上方。

### 验证

打开 `http://127.0.0.1:8848/tests/supersplat.html`，点击「运行验证」。
测试使用真实二进制 PLY 和原版捕获接口读取 GPU RGBA 像素，验证加载、环绕 / 飞行、
动画播放暂停、适应 / 重置、键盘输入隔离、尺寸变化、远处飞点取景、取消 / 销毁、
损坏文件与 HTTP 错误恢复，以及原有视角的平面像素、调平、保存、模式隔离、正交投影、
深度定位、回正与视差，以及模式交接、按模型保存、八种连续形变、爆散/波纹、关闭还原、点云与静止更新。页面输出逐项结果和 JSON 报告。

另用演示入口检查本地文件选择、已有作品切换、展示模式与全屏。原版 Viewer 自动
优先使用 WebGPU，在不可用时回退 WebGL2；当前内置浏览器实测路径是 WebGL2。
手机布局已做窄屏检查，真实触摸、WebGPU、XR 与带碰撞场景还需对应设备和数据验证。
当前查看器验收为 81 项通过、0 项失败，包含真实复选框点击关闭与 GPU 形变还原，
报告：`artifacts/particle-switch-verification.json`。
作品库验证页 `tests/library.html` 为 19 项通过、0 项失败，覆盖真实 PLY 解码、持久保存、
重复与损坏文件、确认/取消删除、失败重试和过期列表；后端删除使用模拟接口，不删除已有作品。
报告：`artifacts/library-verification.json`。真实入口另实测文件选择器、刷新恢复和删除当前本地测试作品。
旧 `tests/effects.html` 是 Spark 历史验证，不代表当前入口。

## 性能调优（本机实测）

两个正交杠杆，均已落地：

**1. GPU 功耗墙（约 1.35×）** —— 笔记本默认 base TGP 仅 50 W，启用 NVIDIA 动态加速后
解锁到 100 W（Dynamic Boost 峰值 115 W）：

```bash
sudo cp /usr/share/doc/nvidia-kernel-common-595/nvidia-powerd.service /lib/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now nvidia-powerd
nvidia-smi -q -d POWER | grep "Current Power Limit"   # 应显示 100.00 W（原 50 W）
```

实测（同素材、1000 步、全分辨率 1080×1920）：墙钟 66.9 s → 49.5 s，SM 2170 → 2737 MHz，
温度 74–80 °C 全程无降频。日志里的 D-Bus 报错
（`not allowed to own the service "nvidia.powerd.server"`）是 Ubuntu 包缺 D-Bus 策略文件所致，
**不影响 TGP 协商**（该协商走 RM 直连），可忽略。

**2. Brush 训练参数（约 1.6–2.5×）** —— 引擎的档位参数硬编码在预编译二进制内，
无命令行覆盖入口。通过 `../ooosplat-test/brush-tune.sh` 包装脚本改写 `OOOSPLAT_BRUSH`
传入的实参实现：high 档由 30000 步 @3200 收紧到 **12000 步 @1440**；fast 档默认原样透传，
只有显式设了 `SPLAT_FAST_*` 才覆盖；balanced 与未知档位原样透传。

| 配置（1000 步口径） | 墙钟 | 相对 full |
|---|---|---|
| full 1920×1080 | 48.7 s | 1.00× |
| `--max-resolution 1440` | 30.2 s | **1.61×** |
| `--max-resolution 1200` | 22.4 s | **2.17×** |

可调环境变量：`SPLAT_HIGH_STEPS` / `SPLAT_HIGH_RES` / `SPLAT_HIGH_STOP`（high 档），
`SPLAT_FAST_STEPS` / `SPLAT_FAST_RES`（fast 档，不设则完全沿用引擎默认）。

> 注意：`--subsample-frames` **只减内存，不减每步训练成本**（实测 0.96×，反而略慢），
> 不要当提速手段。Brush 成本 ≈ 步数 × 每步渲染像素，splat 数影响 < 15%；
> `--max-splats` 无效，`--max-resolution` 是“上限”（源长边封顶，high 传 3200 实际跑满源分辨率）。

## 已知限制

- 任务队列是内存态，服务停止后不会自动续跑未完成任务；重试会从头生成。旧版本已清理的素材需重新选择。
- 单进程标准库服务器，无鉴权，**仅供本机/内网演示**；默认只听 `127.0.0.1`，
  要用 `--host 0.0.0.0` 显式对外，此时局域网内任何人可上传/删除任务。
- 上限与超时可用环境变量调整：`MAX_UPLOAD` 硬编码 4 GiB，另有
  `SPLAT_MAX_CONNECTIONS`（32）、`SPLAT_SOCKET_TIMEOUT`（60s）、`SPLAT_UPLOAD_TIMEOUT`（600s）、
  `SPLAT_MAX_ZIP_ENTRIES`（2000）、`SPLAT_MAX_ZIP_ENTRY_BYTES`（256 MiB）、
  `SPLAT_MAX_ZIP_TOTAL_BYTES`（2 GiB）。
- 磁盘占用由启动参数与自动回收机制约束（见上文「磁盘占用策略」）；
  `--max-jobs` / `--max-data-gb` 只淘汰已完成/失败任务，**运行中任务不会被淘汰**，
  配额极小且任务很重时仍可能暂时超限（服务端会告警而非强杀）。
