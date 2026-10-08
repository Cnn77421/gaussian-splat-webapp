# 组件与主题来源

`web/vendor/shadcn/` 固定保存本项目的组件与主题规范来源，页面不访问外部 CDN。

## 来源

| 内容 | 地址 | 许可证 |
|---|---|---|
| 主题 token 约定与默认主题 | https://ui.shadcn.com/docs/theming | MIT |
| 组件定义（New York 样式） | `https://ui.shadcn.com/r/styles/new-york/<组件>.json` | MIT |

抓取日期：2026-10-08。`registry/` 为抓取时的原始响应，用于核对与离线复现；
`theme.css` 与 `web/style.css` 的组件层是这些响应的等价纯 CSS 翻译。

## 校验值（SHA-256）

| 文件 | SHA-256 |
|---|---|
| `registry/button.json` | `4d8f39c3bd25e630b5962667722e8707e7b18122ad6842a5c22acf8a3ff9f93a` |
| `registry/input.json` | `4d1a3b126cc62485b225e3da32d4a56df851c95c5a24035af1f1c80f33726cfa` |
| `registry/card.json` | `e6b5055ff2e674007d65df1b1e13f7e18eaba86efda60641c02ee6abaec337ce` |
| `registry/dialog.json` | `e240f8eaa9e9e626dffa1a340469c6bace9c631e78b7b10e7d0f178a32a1c71c` |
| `registry/badge.json` | `ce3f01e6d6785477a7fee003bd7144d7d11e7c5e8e31b3373de15138349361e6` |
| `registry/progress.json` | `5b99e42b997efaef90fa01f64f35046d5015ff4ecc63887163dd112df7f92fac` |
| `registry/separator.json` | `01173bde1937c35da6f84f92bb85f7e882a9091064b4532a058177fe1a96d17f` |
| `registry/label.json` | `ea924e70d496cbd6986591ad75f2cbfeb9649f1ce2750cd6dbfb522833e4bcdb` |
| `registry/theming.md` | `403a71fea629dd9d5eebdf3656baab6b8550972adfb4fc5ed0847d13b3dc73f0` |
| `theme.css` | `2942d09d916cb88525f97e9fd1e1f9741e1dc88bf2aa71380c408080d29c664c` |

## 本项目的落地方式

- **零构建**：官方组件是 React + Tailwind + Radix 源码，需要打包链；本项目是
  `importmap` + 纯静态文件、依赖固定版本本地保存的离线前端，因此不引入 React /
  Tailwind 运行时。落地做法是把官方组件的 class recipe 翻译成等价的纯 CSS，
  并用官方主题 token 统一配色、圆角、阴影与焦点环。
- **命名**：官方 token 加 `--ui-` 前缀（`theme.css`）；组件样式写在 `web/style.css`
  的「组件层」段落，并逐条标注对应的官方工具类，便于与官方源码比对。
- **颜色**：`theme.css` 保留官方 neutral 取值，`web/style.css` 的 `:root` 用品牌色
  覆盖同名 token；只改这一处即可整体换色。
- 官方还提供 chart、sidebar 与暗色（`.dark`）token，当前界面未使用，未收录。
