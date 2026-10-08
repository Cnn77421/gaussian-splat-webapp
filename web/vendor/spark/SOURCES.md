# 本地依赖与复用来源

- Spark **2.2.0**，MIT，World Labs / Spark contributors。
  https://github.com/sparkjsdev/spark
  固定发行文件：https://sparkjs.dev/releases/spark/2.2.0/spark.module.js
- Three.js **0.180.0**，MIT，Three.js authors。
  https://github.com/mrdoob/three.js/tree/r180
  `three.module.js`、`three.core.js`、OrbitControls 与 Pass 均取自 npm three@0.180.0 的 jsDelivr 镜像。
- `splat-effects.js` 的 Dyno modifier 接入模式改编自 Spark 官方示例：
  https://github.com/sparkjsdev/spark/tree/main/examples/splat-shader-effects
  局部交互参考：https://github.com/sparkjsdev/spark/tree/main/examples/lofi
  复用渲染与 GPU 形变管线；项目新增指针事件、参数面板和局部形变数学。
- 官方接口：https://sparkjs.dev/docs/splat-mesh/ 和 https://sparkjs.dev/docs/dyno-overview/

下载日期：2026-10-01。许可证全文：SPARK-LICENSE.txt、THREE-LICENSE.txt。
页面全部引用本地文件；Spark 的 WASM/worker 位于发行 bundle 中。

## SHA-256

```
d5c3b3722e4e121836b7d26f1260c2a2750973130adfce0aed97bc312b54ead7  spark.module.js
c8211c69345d2e9949dc7a8ac969380497aa0600a5a8ac6a459c8cd02dd9cb8a  three.module.js
eb077d2417f61d3e6d9264c317cabc4ea35769ed6b0ab533067292a550784c20  three.core.js
b97879c748170baadeb3fb84cea1ffdf4674e283dc06042f34e2acb95a76042c  OrbitControls.js
444b409c235ead986893c472e720da1b779a56985c7d10b279c7944b52bd61c5  Pass.js
```
