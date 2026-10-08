# 2026-10-02 重建与精细训练质量改进

本轮修改本地引擎适配层及后端报告接入。新任务立即使用新策略；已有作品保留。

## 原因与修复

1. `brush-tune.sh` 原来将精细档的 30,000 步 / 3,200 上限改成 12,000 步 /
   1,440 上限。现在默认保留引擎请求，只有显式环境变量覆盖时才缩减。
2. 引擎用 COLMAP 的 CUDA 加速状态提供 Brush 显存信息；本机 COLMAP 3.9.1
   是 CPU 版，因此原任务检测为空，配置上限只有 200,000。新增独立
   `nvidia-smi` 检测，本机 RTX 5060 Laptop 实测总显存 8,151 MiB。单 GPU
   空闲超过 4,000 MiB 时，未知显存初始档的容量上限提高到 600,000。
   多 GPU、查询失败或显存不足保持保守配置；原生 OOM 紧急回退不会再次升级。
3. 精细档 COLMAP guided matching 开启，视频 sequential overlap 由 10 调到 20。
   所有匹配路径（包括补帧 pairs importer）沿用 CPU 后端；匹配、提取最多 8 线程。
4. Brush 0.3 的 COLMAP 导入器只读取焦距和主点，没有应用镜头畸变。
   精细档先用 COLMAP `image_undistorter` 同步校正像素、相机和稀疏模型，再训练。
   校正数据写入 `work/brush/dataset-undistorted`，OOM 重试复用。
   透明 PNG/RGBA 输入保持原 Alpha 路径，暂不走会丢失 Alpha 的 RGB 去畸变。
5. GPU 验证暴露 Brush 0.3 的小图读取问题：图像头读取用了固定 16,387 字节
   `read_exact`，合法的较小 JPEG 也会报 `early eof`。训练副本追加文件尾填充，
   不改变解码像素；采用替换文件断开硬链接，保留原图；损坏文件不处理。

实际训练配置保存在 `logs/quality-training.json`，最后一次 COLMAP 尝试的
注册数、模型和低特征画面保存在 `logs/quality-reconstruction.json`。
后端在回收 work 前读入任务 `qualityReport`；不改写引擎原生 `state.json`。
最终作品的注册数仍以 `stats` 为准，补帧失败回退时最后一次尝试可能与最终选择不同。

## 对照验证

对素材 `20261001-203731_VID_20261001_172139/source/input.mp4` 抽取相同 64 帧，
长边限制为 1,000，特征数据库复制后分别匹配。两组均使用同一 COLMAP 3.9.1、
SIMPLE_RADIAL 单相机、8 CPU 线程，允许两视图轨迹。

| 指标 | 原 sequential 配置 | guided + overlap 20 |
| --- | ---: | ---: |
| 最大连续模型注册帧 | 15 / 64 | 31 / 64 |
| 注册率 | 23.44% | 48.44% |
| 稀疏点 | 5,629 | 7,702 |
| 匹配耗时 | 18.02 s | 31.42 s |
| 重建耗时 | 12.06 s | 53.57 s |
| 平均重投影误差 | 0.699 px | 1.003 px |

覆盖增加，同时计算量与平均误差增加，不能只凭注册数量断言画质提升。
该素材包含移动人物、明显转向及空白墙面；4 / 64 帧特征少于 100。
原 571 帧任务最终仅注册 154 帧，桥接增加 83 帧后没有增加注册帧；本轮没有
覆盖或重训该作品，也不把小样本提升比例推算为全视频提升比例。

对照脚本：`tests/benchmark_reconstruction.py`。该脚本使用隔离目录，不读取任务
配置、不创建生产任务；输出目录必须不存在。原始结果保存于
`artifacts/quality-improvement/reconstruction-benchmark.json`。

## GPU 和端到端验证

- 在 RTX 5060 Laptop 上先完成 1,500 步的隔离训练；镜头校正后的测试模型
  导出 418,806 个高斯，约 98.8 MB，验证高于原 20 万容量的训练和导出可用。
- 实际 `splatstudio generate` 以相同 64 帧作为图片序列，精细档全流程成功。
  图片序列用穷举匹配，因此它与上述 sequential 对照不是同一实验。
  注册 43 / 64 帧，保留 67.2% 覆盖警告；生成 24,541 个高斯、5,793,226 字节 PLY，
  总耗时 96.257 秒。独立显存读取成功，容量上限为 600,000，镜头校正已执行。
- 两项 GPU 验证均显式设置 `SPLAT_HIGH_STEPS=1500` 缩短测试；生产默认仍是
  30,000 步。没有完成整段原分辨率视频的 30,000 步画质对照。
- 完整后端回归 37 项通过，覆盖实际 CLI 参数透传、显存失败/歧义/忙碌时回退、
  OOM 配置、Alpha 保留、去畸变相机和图像同步、硬链接隔离及报告留存。
- 后端在确认无活动任务后重载。健康接口正常；10 个原 PLY 的大小和修改时间均未变。

端到端结果：`artifacts/quality-improvement/pipeline-smoke.json`。
完整测试日志：`artifacts/quality-improvement/tests.log`。

## 相关代码与来源

- `../ooosplat-test/quality-runtime.py`：质量参数、独立显存检测、训练副本兼容和去畸变。
- `../ooosplat-test/colmap-quality.sh`、`brush-tune.sh`、`run-ooo.sh`：引擎接入。
- `server.py`：实际质量报告接入。
- COLMAP 匹配建议：https://colmap.github.io/faq.html#increase-number-of-matches-sparse-3d-points
- 固定 Brush 0.3 导入器：https://github.com/ArthurBrussee/brush/blob/v0.3.0/crates/brush-dataset/src/formats/colmap.rs
- 小图读取实现：https://github.com/ArthurBrussee/brush/blob/v0.3.0/crates/brush-dataset/src/scene.rs

旧包装脚本备份在 `../backups/brush-tune-before-quality-20261002.sh`。
