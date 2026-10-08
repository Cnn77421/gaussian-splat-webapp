# 本地依赖与资源来源

与 `../spark/SOURCES.md` 同一规范：固定版本、记录来源与校验值，页面不访问外部 CDN。

## Tweakpane 4.0.5

- 用途：3D 视窗的粒子参数面板（替代原先手写的 `<select>` + 一排 `<input>`）。
- 许可证：MIT（cocopon）。https://github.com/cocopon/tweakpane
- 来源：npm `tweakpane@4.0.5`，https://registry.npmjs.org/tweakpane/-/tweakpane-4.0.5.tgz
- **完整性核验**：tarball 的 base64 SHA-512 =
  `rxEXdSI+ArlG1RyO6FghC4ZUX8JkEfz8F3v1JuteXSV0pEtHJzyo07fcDG+NsJfN5L39kSbCYbB9cBGHyuI/tQ==`
  与 npm 发布的 `dist.integrity` 逐字符一致。
- 页面实际引用 `tweakpane.min.js`；`tweakpane.js` 为未压缩副本，便于排查。

```
0cde7776e6d8a6cd32d128d21e3f203b7e152adc5a5ea8a9b86ff78c0276696c  tweakpane.min.js
cd99b8cbe0fb4ac62a3f876eb2d6363dbdde78851970b874f79a6bb712cfbe66  tweakpane.js
```

主题通过容器上的 `--tp-*` CSS 变量覆盖（见 `style.css` 的 `.fx-pane-theme`），不修改发行文件。

## 背景插画 `assets/kuromi-studio.*`

- 用户提供的生成插画，原图 1672×941 PNG（1.8 MB，`exec-f658e82a…png`）。
- 缩放至 2400×1351 后导出 WebP(q88) 与 JPEG(q88) 双格式，浏览器按 `image/webp` 支持度选择。
- 主色 `#fef7e5` 奶油约 40%、均值 `#f6ede1`，
  与 `gaussian-kuromi-ppt/` 的品牌色（`--bg:#fff8e7`、`--text-1:#63402f`、`--gold:#e5bc60`）同色系。

```
f64dd64cca1f36de657382264c63fae70f13fb9d2edd0db0eee86d6fd51bd19d  kuromi-studio.webp
7e8fb2e6b0471296df543045198e7f2989ad6906e1ae0d841f9f8360c53a7fc2  kuromi-studio.jpg
```

## 手写体 `fonts/storyhand-subset.woff2`

- 家族名 **StoryHand**，源自马善政毛笔楷书 `ma-shan-zheng.ttf`（SIL OFL 1.1，见
  `OFL-ma-shan-zheng.txt`），取自 `gaussian-kuromi-ppt/fonts/`。
- 用 `fontTools.subset` 按本项目 UI 实际用字（HTML 文本 + JS 字符串 + server.py，682 字）
  裁剪为 woff2：**5.6 MB → 237 KB**。
- 未覆盖的 8 个符号（`·←↑→↓≈✧➜`）由 `--font-display` 回退链从系统 `AR PL UKai CN` 取字形。

```
772fdfed5512c2a1b947c2cb9cc4d143640e2cab2fd18e0eaf078ac1fb7d3da3  storyhand-subset.woff2
```

下载/生成日期：2026-10-02。
