# 2026-10-02 局部修复记录

本轮只修改 `server.py` 和 `web/app.js` 的局部逻辑，新增独立测试。
没有重启现有服务、启动训练、修改任务数据或编辑全屏样式、查看器及原 GPU 验证脚本。

## 修复

- Tweakpane 在 change 事件之前已写入绑定对象；去掉值相等时的提前返回，让模式、强度、范围、微动立即同步到特效参数及说明。
- 成功结果显示引擎的 `stats.warning`，保留预览与下载；下一个正常结果清除旧警告。
- 引擎失败时优先选取日志中的中英文诊断，跳过正常进度和警告；没有诊断时显示退出码，不再把 CPU 回退提示当作错误。
- 专用锁串行化任务快照的序列化、临时文件写入与替换；保存失败输出服务端错误；删除任务后立即保存记录。

## 验证

后端测试在临时目录复制并加载真实服务代码，子进程通过 mock 隔离，不触碰项目内任务和素材：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s splat-app/tests -p test_review_fixes.py -v
```

7 项通过；修改前其中 6 项失败。覆盖删除后重新加载、8 线程并发保存、保存失败、运行任务删除保护、无效视频报错、英文引擎诊断及退出码回退。

前端打开 `/tests/review-fixes.html`：8 项通过。测试加载真实 Tweakpane 库，提取当前 `app.js` 的生产函数，派发真实控件 DOM 事件；仅替代 GPU 参数接收端和模型加载，不创建 WebGL 上下文。覆盖四类参数立即同步、说明更新、质量警告、预览下载及旧警告清除。

未重复执行完整 GPU 回归，以避免与其他 agent 的查看器验证争用资源。
网页修改在刷新后加载；后端修改在现有服务下一次正常重启时生效。

## 本轮范围之外

训练队列与取消、每模型默认视角、历史任务页面和作品导出仍是候选任务；上传流式处理已在第二轮完成。

## 追加：HTTP 层与磁盘回收加固（同日第二轮）

仍只改 `splat-app/server.py`（现 1326 行）与 `splat-app/README.md`，未触碰 `web/`、
未重启线上实例（pid 50604 全程未动），全部实验在 `/tmp/splat-review-sb` 沙箱（端口 8899）进行。

- 上传：`Content-Length` 非法回 400（原先回 0 字节响应）；截断上传回 400 并清掉
  `data/uploads/staging/*.part`；超 4 GiB 回 413 并关连接；body 改为 1 MiB 分块流式落盘，
  带 600 s 墙钟上限（`SPLAT_UPLOAD_TIMEOUT`），不再整包读进内存。
- 请求走私：`_CountingReader` 统计已消费字节，`handle_one_request` 统一排空剩余 body
  （上限 8 MiB，超限直接关连接）；GET/HEAD/DELETE 声明 body 即视为异常关连接。
- 静态路径：改用 `Path.resolve()` + `relative_to(WEB_DIR)`，`/../`、`%2e%2e` 一律 403。
- zip 防线：条目数 2000、单条 256 MiB、整包解压 2 GiB（各自可用 `SPLAT_MAX_ZIP_*` 调整），
  逐块累计写盘量，解包失败会连 `uploads/<jid>` 一起回收。
- `HEAD /api/download` 只发头不发体（原先会漏写整个 PLY）。
- 连接上限 `SPLAT_MAX_CONNECTIONS`（32）+ `SPLAT_SOCKET_TIMEOUT`（60 s），超限回 503。
- CORS 预检放行 `X-Filename`；Web 资源改 `Cache-Control: no-cache`，`/api/*` 仍 `no-store`。
- 新增字段 `inputPath` / `finalPly` / `returncode`，任务对象字段与 README 描述对齐。
- 关停：SIGINT/SIGTERM 触发 `server.shutdown`，先杀引擎**整个进程组**
  （`start_new_session=True` + `killpg`），运行中任务标记 `服务停止，任务已中断`，
  `projects/<id>/{work,source,final.ply}` 与中转目录一并回收。
- `_gc_blobs` 改按「blob 是否仍是某项目/上传目录的硬链接」判定，不再看 nlink；
  `_dedup_sources` 启动时把重复素材副本收敛成同一 blob（只读目录时自动跳过）。
- `--host` 默认 `127.0.0.1`（对外需显式 `--host 0.0.0.0`）。

验证：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s splat-app/tests -p 'test_*.py' -v
```

24 项通过（原 7 项 + 新增 `tests/test_http_hardening.py` 17 项：HEAD 无体、Range 206、
路径穿越 403、CORS 头、非法/超大 Content-Length、截断上传清中转、残留 body 排空后
下一请求仍正确、连接上限 503、zip 三类超限、blob 回收与来源去重）。

沙箱实测：zip 炸弹 0.3 MB → 300 MB 被拒；12 条半开连接时线程 9、普通请求 503、断开后回 1；
SIGTERM 后 0.03–0.57 s 退出，无残留 `run-ooo.sh`/子进程，任务记录为 failed。

未做：`_shutdown_cleanup` 未主动关闭在途连接对象（依赖 `server_close` 与 daemon 线程），
仅在长上传阻塞时有最长 `SPLAT_UPLOAD_TIMEOUT` 的收尾等待。
