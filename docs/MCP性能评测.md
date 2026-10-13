# DooKnow MCP 性能与检索质量评测

日期：2026-10-14（Asia/Shanghai）。本报告对应知识库《DooKnow MCP 与知识库检索设计》的运行状态与性能验收，以及开发计划阶段九。所有源文件、SQLite、向量、临时 Git 和测试身份均在被 Git 忽略的 `.local/benchmarks/` 下独立生成；没有读取真实知识库，也没有启停常驻服务。

## 可复现入口

从本项目根目录执行，复用现有 `node_modules`、Python 项目环境和已经校验的离线模型：

```bash
node_modules/.bin/tsx scripts/search-benchmark.ts --counts 10000,100000 --concurrency 5 --queries 100 --warmup 10 --threads 2 --seed 20261014
runtime/vector-service/.venv/bin/python runtime/vector-service/benchmark.py --counts 10000,100000 --concurrency 5 --queries 100 --warmup 10 --threads 2 --seed 20261014
node_modules/.bin/tsx scripts/file-benchmark.ts --concurrency 2 --queries 100 --warmup 10
node_modules/.bin/vitest run tests/benchmarks
runtime/vector-service/.venv/bin/python -m pytest tests/benchmarks/test_vector_benchmark.py -q
```

三个命令各自创建独立结果目录，并输出 `resultFile`。`result.json` 包含参数、原始延迟、P50/P95、吞吐、CPU、RSS 和事件循环延迟；检索结果另保留 `labels.json` 与逐题实际路径。可使用 `--output` 在 `.local/benchmarks` 内指定父目录；其他目录及软链接出口会被拒绝。`--validate --counts 128 --queries 5 --warmup 1 --no-background` 可快速验证真实 BGE 检索、权限与消息预算。CLI 不接受真实知识库或外部 DATA_ROOT。

复用前先验证 root/knowledge/data 的真实目录与设备/inode 身份，再启动任何 runtime 或 DB。result/labels 输入拒绝软链接、硬链接和非普通文件，分别限制 8 MiB/1 MiB，使用 `O_NOFOLLOW` 与有界流读取，并复核文件身份；SQLite/WAL/SHM 链接目标和 runtime 索引目录链接也会在启动前拒绝。11 个真实 CLI 失败用例已验证拒绝前不向保护目录写入 token、索引或数据库；测试全部使用自有保护夹具。

## 测量方法与限制

- 主机：AMD Ryzen 7 255，8 核/16 线程，约 22.3 GiB RAM；Node.js 22.22.1、Python 3.14.4、NumPy 2.5.4、PyTorch 2.14.1+cpu、SentenceTransformers 6.1.0。本机仍承担其他开发工作，结果不是独占硬件测量。
- 首版后端为 `flat_file`，向量为 512 维 little-endian Float32，1 万和 10 万行分别占 20,480,000 与 204,800,000 字节。Python/BLAS/模型推理线程均固定为 2。
- 模型为真正离线运行的 `BAAI/bge-small-zh-v1.5`，固定修订 `7999e1d3359715c523056ef9478215996d62a620`，启动校验 SHA-256 manifest。随机数值矩阵与真实模型语义评测分开报告。
- 检索测量是 5 并发闭环短查询，每阶段先预热 10 次，再测 100 次。P50/P95 使用 nearest-rank，吞吐按整个测量阶段的墙钟计算。CPU 按一个核等于 100% 表示，可超过 100%。Node 与 BGE 子进程统计相加；独立 tokenizer 的 CPU 不计入，报告明确该限制。
- RSS 和事件循环每 10 ms 采样，并读取阶段末 RSS。小于采样间隔的峰值可能遗漏。冷启动表示新进程加载/校验本地模型，未清空主机文件页缓存。
- 规模夹具使用真实 `text.stage/publish`；29 个独立合成输入由真实 BGE 编码，相同文本复用真实向量，再流式写入规模矩阵。它测量重复内容、向量缓存有效时的完整夹具建库，不等于 10 万篇独立文本的生产任务全量重建。
- 后台工作通过实际索引 worker 执行本地 tokenizer、BGE 文档推理、持久任务和 generation 发布。数值基准的后台工作是有界随机矩阵生成与文件写入，不能称为模型建库。
- `vector-runtime` 包含回环 HTTP 与精确点积，使用预先构造的 row bitmap；`vector-adapter` 还包含真实授权候选 bitmap 生成。后者与前者分别记录，避免掩盖 SQL/权限过滤成本。`hybrid` 从机器 API HTTP 请求计时，包含查询 embedding、SQLite、过滤、RRF、版本复核与返回组装。

## 人工标注状态

[问题集](../tests/benchmarks/fixtures.ts)有 72 条显式标签：66 条正例/目录限制，6 条无关问题；覆盖中文两字短词、英文标识符、语义改写和目录约束。标签由 AI 为隔离样例编写，可逐题人工审查，**不是用户真实库的人工金标准**。报告 Recall@10、MRR、nDCG@10、无关问题返回任意结果的比例、目录过滤越界次数和权限哨兵泄漏次数；质量结论仅适用于这份合成夹具。

设计要求的至少 50 条真实人工标注问题仍待用户提供或审查确认。不能因为合成标签数量超过 50 就把该项记为已验收。

## 实测结果

两种规模均已实际执行 100 次/阶段、5 并发、10 次预热，并有真实后台索引任务。修复后的查询报告分别为：

- [1 万片段复测原始报告](../.local/benchmarks/search-0zFXNp/retest-10000-yQaMAI/result.json)。
- [10 万片段复测原始报告](../.local/benchmarks/search-stsea1/retest-100000-FqPzQD/result.json)。
- [初轮原始报告](../.local/benchmarks/search-6pfBgf/result.json)与修复前建库证据仍保留。

原始文件在本机忽略目录中，Git 只保存工具、标签和本文；其他机器执行上述命令会产生新的结果目录。复测使用原有真实向量与文件，原报告未被覆盖；主语料标称为 1 万/10 万，后台工作累计增加少量片段，每阶段实际 `activeChunksBefore` 已写入 JSON（10 万复测为 100160–100280）。

| 规模与组件            | P50 ms | P95 ms | 查询/秒 | CPU % | P95 工程目标 | 结果   |
| --------------------- | -----: | -----: | ------: | ----: | -----------: | ------ |
| 1 万 text 机器 API    |  21.26 |  86.69 |  161.01 | 110.2 |       100 ms | 达标   |
| 1 万 vector-runtime   |  47.14 |  62.19 |  119.05 | 326.0 |       100 ms | 达标   |
| 1 万 vector-adapter   |  52.88 |  74.45 |  110.62 | 394.3 |       100 ms | 达标   |
| 1 万 hybrid 机器 API  | 125.12 | 540.85 |   28.92 | 313.9 |       500 ms | 未达标 |
| 10 万 text 机器 API   | 129.73 | 405.83 |   28.23 | 103.3 |       100 ms | 未达标 |
| 10 万 vector-runtime  |  94.26 | 129.39 |   52.89 | 553.2 |       100 ms | 未达标 |
| 10 万 vector-adapter  | 219.64 | 408.41 |   21.66 | 620.5 |       100 ms | 未达标 |
| 10 万 hybrid 机器 API | 312.30 | 679.41 |   13.70 | 382.7 |       500 ms | 未达标 |

10 万初轮的 text/vector-adapter/hybrid P95 分别为 1066.95/1062.85/3808.72 ms。主任务增加原生 SQL bitmap 聚合与缓存、有界候选扩展、状态 SQL 聚合、generation pin/retire 后，复测有所改善，但不能称为已经满足全部性能目标。

修复后 query 阶段 Node 峰值 RSS：1 万最高 200.9 MiB，10 万最高 225.1 MiB；BGE/矩阵进程的整个后台任务峰值：1 万最高 851.7 MiB，10 万四个阶段分别约 1372.2/1462.4/1526.8/1529.9 MiB。模型驻留和向量/映射均包含在后者，不能套用 16/64 MiB 文件工程预算。旧进程 baseline 随 generation 发布持续增至约 1807 MiB，修复后内存增长减缓。10 万 text/hybrid 的 Node 事件循环 P95 为 118.9/95.0 ms；CPU、RSS 与事件循环的全部阶段数据保留在原始报告。

严格刷新成功耗时为 1 万 267.69 ms、10 万 1910.90 ms，未触发 10 秒 deadline；这些数字不进入普通查询 P95。两种规模新 BGE 进程冷加载/校验均约 2.47 秒，模型初始 RSS 约 533 MiB。

### 质量结果

两种规模修复后的合成问题集结果相同：

| 模式     | Recall@10 | MRR@10 | nDCG@10 | 无关问题误命中 | 目录越界 | 权限泄漏 |
| -------- | --------: | -----: | ------: | -------------: | -------: | -------: |
| text     |    0.8636 | 0.7712 |  0.7936 |       3/6，50% |        0 |        0 |
| semantic |    0.9545 | 0.8231 |  0.8545 |      6/6，100% |        0 |        0 |
| hybrid   |    0.9545 | 0.8343 |  0.8643 |      6/6，100% |        0 |        0 |

初轮 semantic/hybrid Recall@10 为 0.9697；改用初始 50、有界扩大至 500 的候选后，本合成集下降约 1.5 个百分点。当前语义检索没有按此问题集校准拒识阈值，无关问题仍返回近邻；返回结果不能被解释为问题已经得到正确回答。所有模式都实际执行了无权限目录哨兵查询。

### 冷启动与建库

纯生产任务链另用 20 篇独立合成文档执行从 reconcile、持久化双路 jobs、快照、真正 chunker、无缓存 BGE、prepare/finalize 到 publish 的完整建库；20 个片段、40 个 jobs 全部 `done`，实测约 4.17–4.33 秒。示例[完整任务链报告](../.local/benchmarks/search-i58Wqf/production-build-t4KiG2/result.json)。这项与规模夹具的流式 bulk 向量准备分开记录。

初轮规模夹具建库耗时为 1 万 180.10 秒、10 万 350.54 秒，其中真实 29 输入 BGE 编码各约 0.41/0.36 秒，向量文件首次加载约 51.88/305.14 ms。两轮都包含 `chunk_terms` 索引的中途迁移，**不是干净修复后的全量建库成绩**。完成 schema 修复后复测查询复用已有库，没有重新测 1 万/10 万完整建库，也没有测 10 万条独立文本的生产任务 rebuild。

已有规模夹具可直接重测，保留原始报告；新的结果另存忽略目录：

```bash
node_modules/.bin/tsx scripts/search-benchmark.ts --reuse .local/benchmarks/search-6pfBgf/search-100000-lK2AWh --counts 100000 --queries 100 --warmup 10 --concurrency 5 --threads 2
node_modules/.bin/tsx scripts/search-benchmark.ts --reuse .local/benchmarks/search-6pfBgf/search-10000-5Btnh1 --counts 10000 --queries 100 --warmup 10 --concurrency 5 --threads 2
```

`--no-background` 可单独观察无建库竞争的查询，但不能将其数据替代本表的后台工作验收口径。

### 随机数值基线

最终[数值基线原始报告](../.local/benchmarks/vectors-06hw6lhy/result.json)运行同一个 `FlatIndex.search`，以种子生成归一化随机矩阵，只测精确计算开销，不用于语义 Recall。5 并发、100 查询、10 预热、2 BLAS 线程，后台为有界数值生成/写文件：

| 数值矩阵  | P50 ms | P95 ms | 查询/秒 | CPU % | 100 ms 目标 |
| --------- | -----: | -----: | ------: | ----: | ----------- |
| 1 万×512  |   2.81 |   4.25 | 1586.69 | 484.6 | 达标        |
| 10 万×512 |  73.49 |  89.92 |   68.10 | 483.9 | 达标        |

这个表不包括真实查询模型推理、权限 bitmap、后台模型建库或机器 API，不能拿其 P95 替代上面的语义/混合搜索结果。

### 已发现并修复的建库瓶颈

初次真实 `text.stage` 构建约 90 秒后仅达到 5,509 个片段、559,002 个词项。`DELETE FROM chunk_terms WHERE chunk_id=?` 的实际查询计划为 `SCAN chunk_terms`，逐片段清理导致随规模增长的重复全表扫描。主任务在 schema 增加 `chunk_terms_by_chunk(chunk_id)`，自有夹具重新执行生产迁移后，查询计划变为 `SEARCH chunk_terms USING COVERING INDEX chunk_terms_by_chunk (chunk_id=?)`。修复前证据保留在 `.local/benchmarks/search-6pfBgf/build-before-fix-evidence.json`。

### 大文件口径

文件基准以 64 KiB 有界块生成 1/2/20 MiB 样本，包含中文/emoji/CRLF、没有换行的长单行，以及没有换行的引号、反斜线和控制字符密集转义。分页只读取当前预算范围，网关不会接收整篇 20 MiB 正文；patch 使用已加载范围和真实哈希，worker 流式生成历史和新正文，最终仅核对摘要、尺寸和流式哈希。

文件 worker 和网关预算函数运行在独立预加载进程。网关先预热 10 次，分别记录单请求与两并发 100 次读取阶段的 RSS；后者不冒充单请求内存。`structuredContent` 与兼容 text 均计入完整 JSON-RPC wire 大小。warm 读取重复请求相同有界首段，不代表全文件下载吞吐。文件测试为每个样本分配独立测试身份，保留真实的每身份快照配额。

最终[文件基准原始报告](../.local/benchmarks/files-x8iyrI/result.json)包含九种文件和 20 MiB+1 字节超限样本：

| 原始大小 | 类型            | 首段含快照 ms | 分页 P95 ms | patch 完成 ms | worker 额外 RSS MiB |
| -------- | --------------- | ------------: | ----------: | ------------: | ------------------: |
| 1 MiB    | 中文/emoji/CRLF |        101.37 |        7.52 |         32.41 |                7.68 |
| 1 MiB    | 长单行          |         17.15 |        9.03 |         22.68 |                1.29 |
| 1 MiB    | 密集转义        |         19.36 |        9.47 |         22.48 |                3.53 |
| 2 MiB    | 中文/emoji/CRLF |        112.62 |        5.50 |         29.58 |                8.77 |
| 2 MiB    | 长单行          |         23.81 |        7.90 |         30.21 |                6.52 |
| 2 MiB    | 密集转义        |         24.54 |        8.98 |         31.42 |                1.82 |
| 20 MiB   | 中文/emoji/CRLF |        992.37 |        4.62 |        144.92 |                7.10 |
| 20 MiB   | 长单行          |        137.57 |       10.37 |        125.32 |               16.11 |
| 20 MiB   | 密集转义        |        124.43 |        8.45 |        123.85 |                2.91 |

预加载后的网关单请求额外 RSS 最大约 2.73 MiB，100 次/两并发阶段额外 RSS 最大约 9.29 MiB；文件 worker 单任务最大约 16.11 MiB。在本采样口径下分别通过 16/64 MiB 工程目标。完整消息最大 48,327 字节、正文最大 16,383 字节；密集转义正文被实际预算收缩到 8192 字节，而不是返回 16 KiB 后突破 64 KiB wire。patch 成功仅返回约 1.2 KiB 摘要。20 MiB+1 字节读取实际返回 413 `FILE_TOO_LARGE`。

本基准没有计时 OAuth/MCP 网络传输、浏览器 DOM/编辑器输入或公开分享并发；这些能力不能由本结果替代验收。脚本测试不安装依赖、不提交或推送生成数据。

## 工具验证与剩余验收

最终基准测试 `vitest run tests/benchmarks` 为 17/17，通过 11 个先失败后通过的链接/输入预算 CLI 用例，以及真实离线 BGE 的完整建库、机器检索和复用报告保留测试；Python 数值测试 3/3，独立 `--validate` 返回正确数值真值并明确 `semanticQualityMeasured=false`。`vue-tsc --noEmit`、Prettier 与 Git diff 检查通过。

此前全套 Web 测试的唯一失败是开发中的 `jobs.preempt` 尚未实现；根节点补齐后记录的全套为 87/87、types/build 通过、e2e 14/14、Python runtime 12/12。新增的 11 个隔离拒绝测试在其后交付，最终全分支计数由根节点统一复核。

仍未验收：至少 50 条真实人工问题的质量金标准；干净修复后的 1 万/10 万完整建库与 10 万独立输入生产 rebuild；当前未达标的普通 P95；最新后台任务 preemption 后的性能复测；真实 OAuth/MCP 客户端、浏览器输入与公开分享/索引并发。上述限制不影响本轮实际测得的数据，但不能将相应计划项标为全部完成。
