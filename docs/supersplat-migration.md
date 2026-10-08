# SuperSplat 展示预览接入（2026-10-02）

## 实现

当前演示入口基于 npm 官方 SuperSplat Viewer 1.36.2 完整 JS/CSS 导出。
官方原件保留；运行时使用可重建的 `host-viewer.js` 相机交接适配版本。
内置 PlayCanvas 2.22.6；无需 npm install、外部 CDN 或在线 SuperSplat 账号。
许可证、来源、固定版本与 SHA-256 见 `web/vendor/supersplat/SOURCES.md`。

`web/supersplat-preview.js` 负责加载生命周期、宿主键盘输入隔离、PLY 取景适配与原有视角模式的生命周期。
主页面保留生成流程与主题；新增展示模式、封面作品库、本地 PLY 导入和对应下载。
后续按前端设计统一预览 UI：`web/viewer-theme.css` 覆盖宿主主题，奶油色浮层、棕色文字、
紫色选中态、纸艺圆角描边、工具栏模式文字与焦点描边；原版 vendor JS/CSS 保持原样。
窄屏工具栏换行，设置展开时折叠原有视角控制并保留退出；信息弹窗避免被控制面板遮挡。
原版环绕、飞行、时间轴、设置、帮助、信息、适应、重置、全屏 UI 均来自原包。
普通 PLY 默认暂停自动动画，用户可点播放启动。
「原有视角」与环绕、飞行并列，使用 `web/legacy-view-controls.js` 复用迁移前 Three.js 0.180.0
OrbitControls 驱动同一个 PlayCanvas 相机。独立输入面层隔离手势；原版 vendor 保持原样。
支持辅助平面、倾斜调平与按模型保存水平面、WASD、视角预设、自动环绕、正交投影、相机信息、
全屏、松手回正与鼠标视差。中键定位复用原版 `picker:ready` 提供的 GPU 深度拾取。
各模式继承当前机位、旋转和视野角，切回环绕/飞行恢复原版输入与透视；宿主编辑控件不触发视角快捷键。
行走按原版碰撞数据条件显示，本次不新增碰撞生成、Studio 或账号/评论系统。

## 取景

有些 Brush 产物带远处飞点，完整 AABB 会把模型缩成一小点。
在原版引擎解码后、创建相机前，从坐标抽样计算 1%–99% 分位 customAabb 和初始机位。
原版适应/重置复用该范围。模型字节、粒子数量和坐标保持原样；范围外的飞点可能被显示裁剪。
不复制整个 PLY、不重复下载模型、不修改 vendor。

## 验证

- `web/tests/supersplat.html`：81 项通过，0 项失败，当前报告为 `artifacts/particle-switch-verification.json`。
  早期 54 项结果保留在 `artifacts/legacy-camera-verification.json`。
  实际 GPU RGBA 像素、4,800 粒子 PLY 解码、播放暂停、环绕/飞行、移动、重置、适应、
  输入焦点隔离、画布尺寸更新、离群点取景与粒子保留、加载取消、损坏文件和 HTTP 错误恢复。
  新增原有模式的焦点与输入隔离、辅助平面真实 GPU 像素、相机调平、旧坐标保存、
  WASD/Shift+WASD、数字预设、自动环绕、正交投影、信息、GPU 深度定位、空白定位保护、
  鼠标视差不累积、松手回正保距、模型切换保留模式但水平面与默认机位按模型隔离。
  退出修复补充再次点击模式按钮、收起面板时的退出按钮、Esc、恢复原版输入与投影、
  清除模式偏好以及连续进入退出的检查。
  初次迁移的 24 项报告仍保存在 `artifacts/supersplat-verification.json`。
- 真实入口按 U 显示网格、方向键调平、O 切换投影，F 进入与退出全屏；
  退出后恢复页面尺寸。截图为 `artifacts/legacy-camera-preview.png`。
  退出修复在真实入口验证了按钮切换、标题栏退出、Esc，以及全屏时第一次 Esc 退出全屏、
  第二次 Esc 返回环绕。新增退出入口截图为 `artifacts/legacy-camera-exit-preview.png`。
- 真实入口实际加载现有 44,421 / 78,325 / 200,000 粒子模型，检查了已有作品切换。
- 用页面文件选择器导入本地 `tests/interaction.ply`；确认下载指向该 blob、旧任务 URL 被清除。
- 原版全屏按钮实际进入全屏，退出后恢复页面；侧栏可展开收起。
- 主题更新后实测 375px / 812px 窄屏，页面 scrollWidth 与 clientWidth 均为 375px，
  工具栏换行、设置展开折叠原有控制、退出入口可见；临时 viewport 已 reset。
  默认尺寸截图为 `artifacts/viewer-theme-preview.png`，窄屏截图为 `artifacts/viewer-theme-mobile.png`。
  新主题下原有 54 项回归通过，报告为 `artifacts/viewer-theme-verification.json`。
- 当前 GPU 路径为 WebGL2。原版 WebGPU 自动回退正常；WebGPU、真实移动触摸、XR 与碰撞行走未实机验证。
- JS 语法检查通过；HTML ID 无重复。

## 旧实现

迁移前页面的 app.js、index.html、style.css 保存在 `artifacts/pre-supersplat/`。
历史 Spark 源码保留为参考；粒子形变公式已移到当前 PlayCanvas 工作缓冲着色器中，当前入口不加载 Spark 渲染器。
旧交互说明见 `docs/legacy-spark-interactions.md`；其中相机操作已作为第三种模式恢复。
此次无需重新训练模型。已有 PLY 的画面缺陷仍取决于拍摄和训练质量。

## 展示与特效更新

- `web/view-preferences.js` 使用 `splat.view.v2.<modelKey>` 存储模型水平面和默认视角。
  后端作品用 job ID；本地文件用名称、大小和修改时间。原全局 raw-COLMAP 平面只迁移一次。
- `web/work-gallery.js` 真实捕获模型封面、IndexedDB 缓存、名称搜索和点击展示。
  缺失封面在作品库打开时逐个生成；关闭/选择时取消，避免多个后台模型累积。
- `web/particle-effects.js` 提供原八种连续形变、四槽爆散/波纹脉冲、强度/范围/微动、总开关、X/P/粒子尺寸。
  GLSL/WGSL 使用同一公式；通过公开的 `setWorkBufferModifier` / `setParameter` 在排序前修改粒子。
  关闭特效恢复基础模型，静止后停止工作缓冲更新。当前实际 GPU 验证路径为 WebGL2；WGSL 未实机验证。
- `scripts/build-viewer-adapter.py` 从未修改的原始运行时生成相机适配版；匹配校验避免升级时静默改错位置。
  只增加快照入口、保持 FOV/飞行倾斜、环绕/飞行直交接；旧运行时和 CSS 校验值不变。
- 窄屏打开粒子、原有操作、原生设置时互相折叠，保留操作和退出入口。

### 最新验收

`artifacts/particle-switch-verification.json`：81 项通过，0 项失败（真实 WebGL2 GPU）。
新增模式切换位置/旋转/FOV不跳变，默认视角保存、暂停初始画面保存、重新打开恢复、跨模型隔离，
八种连续形变的真实像素、爆散/波纹、关闭原状还原、参数保留、点云与静止停止更新。
真实入口验证 10 张封面生成并在刷新后读回，名称搜索、卡片选择更新 URL、下载链接与单实例切换。
375×812 下 scrollWidth/clientWidth 均为375，原有模式与特效面板不相交，退出按钮可用。
截图：`artifacts/showcase-gallery.png` / `artifacts/showcase-mobile.png` / `artifacts/showcase-preview.png`。

### 作品库管理与特效开关修复

作品库增加多文件 PLY 导入、原生解码检查、浏览器持久保存、封面和删除确认。
本地导入使用独立的 `splat-library` IndexedDB，避免旧封面缓存页面阻塞数据库升级。
生成作品删除接入已有 `DELETE /api/jobs`；失败保留卡片，删除后清理封面、默认视角和当前预览。
导入模型刷新可通过 `?work=<id>` 恢复。原始本地文件不会因删除作品而改动。

特效面板此前在 checkbox 的 click 中同步旧状态，抢在 input/change 前恢复勾选，导致关闭无效。
修复后仅操作按钮同步面板，关闭时取消指针定位和脉冲，并恢复基础粒子位置。
查看器测试通过真实 checkbox 点击验证关闭和重新开启，包含 GPU 还原检查。

`tests/library.html`：19 项通过、0 项失败，报告 `artifacts/library-verification.json`。
隔离数据库与模拟后端覆盖导入、持久保存、损坏/重复文件、确认/取消删除、失败重试和过期列表。
真实入口使用自建 PLY 实测添加、刷新、展示和删除当前作品；已有 10 个生成作品均保留。
截图：`artifacts/gallery-management.png` / `artifacts/gallery-delete-confirmation.png` / `artifacts/particle-switch-off.png`。
