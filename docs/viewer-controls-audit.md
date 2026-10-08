# 查看器控制核对

核对日期：2026-10-01。

## 读取的源码

- 用户指定的 [OOOSplat 仓库](https://github.com/ooolabdev/ooosplat)，
  本次读取的 HEAD 为 `0e19a3b74122c3bab0103bc2ad3140da0853c74f`。
- [ViewerControls.ts](https://github.com/ooolabdev/ooosplat/blob/0e19a3b74122c3bab0103bc2ad3140da0853c74f/src/components/GaussianViewer/ViewerControls.ts)：
  当前 0.5.0 使用 PlayCanvas；普通模式左键 Orbit、右键 Pan、滚轮 Zoom，矩形选择模式用中键 Orbit。
- [GaussianViewer.tsx](https://github.com/ooolabdev/ooosplat/blob/0e19a3b74122c3bab0103bc2ad3140da0853c74f/src/components/GaussianViewer/GaussianViewer.tsx)：
  键盘处理为调整模式的撤销/重做，以及矩形选择的 Escape / Delete / Backspace。
- 历史版本 `84ab862` 和初始版本 `04fa691` 的前端预览入口与相机控制。
- 当前网页迁移前实际使用的 `web/vendor/gaussian-splats-3d.module.js`：
  `Viewer.onMouseUp` → `onMouseClick` → `checkForFocalPointChange` → `updateCameraTransition`。
  这条调用链在点击命中高斯后改变 `controls.target`，保持相机位置并显示焦点标记。
  `onMouseUp` 未限定鼠标按钮，因此中键单击也有定位行为；中键拖动缩放来自另一层 OrbitControls。

上游当前主分支与本网页迁移前的查看器不同，不能只用 OrbitControls 的按钮映射判断完整交互。
本网页的 WASD / U I O P 等行为来自迁移前的 GaussianSplats3D 查看器，不是上游新版 PlayCanvas 调整工具。

## 当前网页的保留与适配

| 操作 | 当前行为 |
| --- | --- |
| 左键拖动 | 旋转，有惯性阻尼 |
| 中键单击模型 | 新鲜 Spark 射线命中 → 320ms 切换旋转中心；保持相机位置，短暂显示定位标记 |
| 中键单击空白 | 保持中心，提示未命中 |
| 中键上下拖动 | 推进 / 拉远；累计移动超过 3px 后不触发单击定位 |
| 右键拖动 | 平移 |
| 滚轮 | 缩放 |
| WASD | 平移 |
| Shift + WASD；画布内 Ctrl/Meta + WASD | 旋转 |
| U | 跟随当前中心与相机 up 的辅助平面；打开时重新对齐到当前视角平面 |
| I | 相机、光标、渲染数量、排序任务与画布信息 |
| O / P | 正交与透视 / 点云与高斯 |
| C / G / + − / ← → | 命中光标 / 焦距系数 / 粒子大小 / 相机倾斜（同时更新视角平面） |
| F | 网页层接管为 3D 视窗全屏：只放大中间预览（`#viewerPanel`），工具栏收成右上角浮层，Esc 或再按 F 退出 |
| Shift + U | 把当前相机 up 保存为默认视角平面（localStorage `splat.viewPlaneUp`），之后所有预设视角套用 |
| 0–6 / R / X | 当前网页视角预设 / 环绕 / 清除粒子特效 |

为保留当前网页的粒子脉冲交互，左键单击用于波纹或所选爆散模式；定位独立放在中键单击。
中键定位不触发波纹或爆散，不受粒子特效总开关影响，在透视与正交模式下都可使用。
定位动画期间新的鼠标、滚轮、WASD、预设视角或投影切换会取消过渡。

`/tests/effects.html` 使用真实 PLY 和 Spark 射线命中验证定位目标、相机位置、定位标记、空白未命中、
拖动不误触、总开关关闭、正交模式与控制权取消，并保留其余粒子和键盘回归检查。
默认视角平面：`applyView()` 用 `SparkViewer.setViewPlane()` 套用保存的世界系 up（无保存值时为 −Y），
「恢复默认平面」按钮清除 `splat.viewPlaneUp` 并调用 `resetViewPlane()`；改 up 必须走 `setCameraUp()`，
否则 OrbitControls 0.180 缓存的 `_quat` 会与相机轨道轴错位。
