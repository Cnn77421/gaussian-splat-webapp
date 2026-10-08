# 前端组件库选型调研

面向 `splat-app/web/` 的优化。目标：让「参数面板 / 上传 / 进度 / 提示 / 预览控件」这些重复手写 UI 用成熟库替代。

## 硬约束（先过滤掉一半候选）

现有前端是**零构建**的：

- 没有 `package.json`、没有打包器、没有 `node_modules`；`index.html` 用 **importmap** 直接映射到 `web/vendor/spark/` 下的本地 ESM 文件。
- README 明确要求「依赖固定版本并保存到 `web/vendor/`，页面不访问外部 CDN」——离线演示。
- 后端是纯标准库，静态文件由 `server.py` 直接吐。

因此选型门槛是：**能作为单个 ESM 文件落进 `web/vendor/`**。

| 门槛 | 通过 | 不通过（需先引入构建链） |
|---|---|---|
| 分发形态 | 单文件 ESM / 单 CSS | 需要 `npm install` + bundler 才能跑的组件集 |
| 依赖 | 零运行时依赖 | 依赖 lit / preact / lodash 等 |
| 安装 | 下载一个文件即可 | 必须 `npm i` 拉 2000+ 文件 |

## 候选清单（版本 / 许可证均取自 npm registry 一手元数据）

| 库 | 版本 | 许可证 | 分发 | 运行时依赖 | 用途 |
|---|---|---|---|---|---|
| [Tweakpane](https://github.com/cocopon/tweakpane) | 4.0.5 | MIT | ESM `dist/tweakpane.js` | **无** | 参数/调试面板 |
| [lil-gui](https://github.com/georgealways/lil-gui) | 0.21.0 | MIT | ESM `dist/lil-gui.esm.js` | **无** | 参数面板（Three.js 官方示例同款） |
| [Web Awesome](https://webawesome.com) | 3.14.0 | MIT（Core） | Web Components | lit、floating-ui… | 通用 UI 组件集 |
| [Notyf](https://github.com/caroso1222/notyf) | 3.10.0 | MIT | ESM `notyf.es.js` | **无**（~3 KB） | Toast 提示 |
| [Toastify JS](https://github.com/apvarun/toastify-js) | 1.12.0 | MIT | ESM | **无** | Toast 提示 |
| [FilePond](https://github.com/pqina/filepond) | 4.32.12 | MIT | ESM `dist/filepond.esm.js` | **无** | 上传 + 缩略图/校验 |
| [Uppy](https://uppy.io) core / drag-drop / status-bar | 6.2.0 / 6.0.0 / 6.0.0 | MIT（插件同为 MIT） | ESM | preact、lodash… | 上传 + 大文件分片/续传 |
| [camera-controls](https://github.com/yomotsu/camera-controls) | 3.1.2 | MIT | ESM module | peer `three>=0.126.1`（已满足 0.180） | 相机控制（平滑过渡） |
| [Pico CSS](https://picocss.com) | 2.1.1 | MIT | 单 CSS | — | 语义化基础样式 |
| [Open Props](https://open-props.style) | 1.7.23 | MIT | 单 CSS（设计令牌） | — | 配色/阴影/尺寸变量 |

### 已淘汰 / 需注意

- **Shoelace 已停止开发**。官网首屏即写明「Shoelace Is Sunset with no active development」，官方指引迁移到 **Web Awesome**（同一团队、MIT、后继版本）。要用 Web Components 就直接上 Web Awesome，不要新起 Shoelace。
- **Web Awesome 免费范围**：Core 组件（官方称约 70 个）为 MIT；另有 Pro 组件与配套资源收费，选组件时需逐个确认。
- **Uppy 的 MIT 是真的**：`@uppy/core`、`@uppy/drag-drop`、`@uppy/status-bar` 的 `license` 字段均为 `MIT`（其 XHR/Companion 类插件亦同）。代价是依赖 preact/lodash，**不符合零构建门槛**，除非愿意引入打包。
- **dat.GUI 不要用**：已被 lil-gui 取代（Three.js 官方示例自 r135 起即用 lil-gui）。

## 针对本项目的建议（按收益排序）

| 优先 | 位置 | 建议 | 理由 |
|---|---|---|---|
| ★★★ | 右侧/3D 视窗的粒子与相机参数面板 | **Tweakpane** | `index.html` 里 `fxMode/fxStrength/fxRadius/fxAmbient/fxExplosion/fxRipple/fxEnabled` 等一排手写 input 全可折叠成 Tweakpane 面板；零依赖单 ESM，直接进 `vendor/` |
| ★★☆ | 提交/失败/完成提示 | **Notyf** | 现在错误只写进 `el.msg`；~3 KB 零依赖，给「上传失败 / 生成完成」加非阻塞提示 |
| ★★☆ | 3D 预览 | **camera-controls** | 已有 `OrbitControls`；若需要平滑切换机位/过渡动画（README 里 6 个预设机位），它比 OrbitControls 更合适，且 peer 版本与现有 three 0.180 兼容 |
| ★☆☆ | 上传区 | 维持现状 / 可选 FilePond | 现有拖拽逻辑约 15 行且工作正常；只有需要缩略图、体积校验、上传队列时才换 FilePond |
| ★☆☆ | 整体样式 | Open Props（或 Pico） | 若想统一配色/阴影/间距变量；**不建议**整站套 Pico，会覆盖现有 190 行定制样式 |
| ☆☆☆ | 通用组件 | Web Awesome | 仅在确实需要对话框/标签页/树等成套组件时引入；需接受 lit 依赖与 `dist` 体积（解包约 17 MB，含全部组件） |

### 最小接入示例（Tweakpane，无需构建）

下载 `https://registry.npmjs.org/tweakpane/-/tweakpane-4.0.5.tgz`，取 `dist/tweakpane.js` 放到
`web/vendor/tweakpane/`，扩展 `index.html` 的 importmap：

```jsonc
{
  "imports": {
    "three": "/vendor/spark/three.module.js",
    // …原有映射…
    "tweakpane": "/vendor/tweakpane/tweakpane.js"
  }
}
```

```js
import { Pane } from 'tweakpane';
const pane = new Pane({ container: document.getElementById('fxPanel'), title: '粒子参数' });
pane.addBinding(params, 'strength', { min: 0, max: 1, label: '强度' });
```

随后 `pane.on('change', …)` 的事件即可替换现有逐个 `addEventListener('input', …)` 的布线。

> 落地时须在 `web/vendor/` 下补一份 `SOURCES.md` 记录版本/下载地址/SHA-256，与现有 `vendor/spark/SOURCES.md` 保持一致。

## 参考来源

- Tweakpane：https://github.com/cocopon/tweakpane ｜ npm 元数据 `tweakpane@4.0.5`（MIT，`type: module`，无 `dependencies`）
- lil-gui：https://github.com/georgealways/lil-gui ｜ `lil-gui@0.21.0`（MIT，`module: dist/lil-gui.esm.js`）
- Web Awesome：https://webawesome.com/license ｜ `@awesome.me/webawesome@3.14.0`（MIT，依赖 lit）
- Shoelace 停更声明：https://shoelace.style/
- Notyf：https://github.com/caroso1222/notyf ｜ `notyf@3.10.0`（MIT，`notyf.es.js`，零依赖）
- Toastify JS：https://github.com/apvarun/toastify-js ｜ `toastify-js@1.12.0`（MIT，0 依赖）
- FilePond：https://github.com/pqina/filepond ｜ `filepond@4.32.12`（MIT，`dist/filepond.esm.js`）
- Uppy：https://uppy.io ｜ `@uppy/core@6.2.0`、`@uppy/drag-drop@6.0.0`、`@uppy/status-bar@6.0.0`（均 MIT，依赖 preact/lodash）
- camera-controls：https://github.com/yomotsu/camera-controls ｜ `camera-controls@3.1.2`（MIT，peer `three>=0.126.1`）
- Pico CSS：https://picocss.com ｜ `@picocss/pico@2.1.1`（MIT）
- Open Props：https://open-props.style ｜ `open-props@1.7.23`（MIT）

数据采集日期：2026-10-01。
