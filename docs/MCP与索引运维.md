# MCP 与本地索引运维

本文件对应 `codex/doo-know-mcp` 源码。所有自动测试使用隔离原文、数据库和回环进程；没有安装常驻服务或在真实知识库上执行故障测试。机器网关独立维护于 [doo-know-bridge](https://github.com/bandoo-2001/doo-know-bridge)，仅调用 `/api/agent/v1`，不挂载原文或数据库。

## 目录与启动顺序

源码在 `/home/bandoo/workspace/projects/doo-know-web`。发布代码放入 `/srv/stacks/knowledge/doo-know-web` /app 发布目录，运行数据放 `/srv/data/knowledge/doo-know-web`，模型放 `/srv/models/bge-small-zh-v1.5`，凭据放 `/srv/secrets/knowledge/doo-know-web`。原文使用明确的 `KNOWLEDGE_ROOT`。这些是部署模板的路径，当前任务没有创建这些服务目录。

使用实际运行用户配置目录权限；授权 JSON 和密钥文件需为 600。复制 `.env.example` 为发布版本外的受控环境文件，填写真实路径，不将凭据本身放进环境文件或 Git。先启动 CPU 向量服务，再启动 Web；嵌入 worker 默认开启，也可显式关闭后启动独立 worker。最后启动网关和已有反向代理。Web、向量、网关的建议回环端口分别为 3010、3081、3071，部署前核对端口占用。

## 项目环境和固定模型

本机已验证 Python 3.14.4、Node 22.22.1、CPU Torch 2.14.1+cpu。Python 的 `.venv` 属于项目环境，不复制到其他主机。依赖在 `runtime/vector-service/requirements.lock.txt` 固定；CPU Torch 使用官方 CPU wheel 源。安装和模型准备是部署操作，以下命令供审查，未在生产目录执行。

```bash
cd /path/to/released/doo-know-web
python3 -m venv runtime/vector-service/.venv
runtime/vector-service/.venv/bin/python -m pip install --extra-index-url https://download.pytorch.org/whl/cpu -r runtime/vector-service/requirements.lock.txt
runtime/vector-service/.venv/bin/python runtime/vector-service/prepare_model.py --help
```

模型固定为 `BAAI/bge-small-zh-v1.5`，修订 `7999e1d3359715c523056ef9478215996d62a620`。准备脚本下载明确的配置、tokenizer 和 safetensors 文件，记录 SHA-256 清单；运行时核对清单，使用 `local_files_only`、CPU、512 维和 L2 归一化，不联网下载或回退云推理。查询使用模型的中文检索指令。分词是独立 stdio 进程，向量服务退出时全文仍能更新。[BAAI 模型说明](https://huggingface.co/BAAI/bge-small-zh-v1.5)、[PyTorch CPU 安装](https://pytorch.org/get-started/locally/)。

```bash
runtime/vector-service/.venv/bin/python runtime/vector-service/app.py \
  --model-dir /srv/models/bge-small-zh-v1.5 \
  --index-root /srv/data/knowledge/doo-know-web/indexes \
  --token-file /srv/secrets/knowledge/doo-know-web/vector.token \
  --host 127.0.0.1 --port 3081
npm ci
npm run build
NODE_ENV=production npm start
```

向量服务 `/health` 仅返回状态；`/describe` 及推理/索引接口需要内部 Bearer。将已核验的 `/describe.spaceId` 填入 `EMBEDDING_SPACE_ID`，使用 `VECTOR_SERVICE_URL`、`VECTOR_SERVICE_TOKEN_FILE`、`VECTOR_RUNTIME_ROOT`、`MODEL_DIR` 和 `TOKENIZER_PYTHON`。空间 ID 包含固定模型文件、tokenizer、查询指令、pooling、归一化、维度和 Float32 规则。模型缺失或空间不符会明确失败。

## worker、同步与修复

默认 `EMBEDDED_FILE_WORKER=1`、`EMBEDDED_INDEX_WORKER=1`。分开运行时关闭对应嵌入 worker，使用编译后的 `dist/server/scripts/file-worker.js`、`index-worker.js` 或项目命令：

```bash
npm run worker:file -- --once
npm run worker:index -- --once
npm run index:maintain -- --full-hash
npm run index:maintain -- --retry-failed
npm run index:maintain -- --rebuild-text --rebuild-vector
```

任务有 60 秒租约、15 秒心跳和递增 epoch；索引最多尝试 10 次，退避从 2 秒到 300 秒。快扫描不会重新打开同一版本的失败任务；显式维护命令才重试。正文变更以单调 `sourceRevision` 和哈希登记，两路各自完成整篇后发布；保存成功不等待向量。文本发布验证字节覆盖，向量先校验并加载不可变文件再切换 generation。查询固定 generation，释放后回收旧矩阵和文件；达到 32 个 segment 或 20% 失效行后后台压实。

监听事件防抖 750 ms，启动完整核对，每 60 秒快核对、每 300 秒完整哈希。`indexed` 搜索报告最后核对时间和待处理状态；`strict` 在授权范围核对并等待版本，10 秒不满足返回 `INDEX_NOT_READY`。普通搜索 5 秒超时，不每次遍历全部 Markdown。目录、分类、已有 YAML `tags` 和日期参与召回；标签只提取前 16 KiB 内完整 Front Matter，最多 16 个字符串，不改写原文。[SQLite FTS5](https://www.sqlite.org/fts5.html)、[YAML AST](https://eemeli.org/yaml/)。

Git 同步默认关闭，只有 `GIT_SYNC_ENABLED=1` 后显式运行 `npm run git:sync`。命令固定为 ff-only，禁用 hooks、fsmonitor 和外部传输，不执行 stash/reset、不覆盖脏工作区。同步期间暂停写入和索引发布，完成后核对；冲突、分叉或根目录身份改变必须由维护者解决，不能误判为删除整个知识库。

改变模型或切片/分词规则前停止相关 worker，保留旧发布和索引目录，在隔离数据目录完成新空间的完整建库、代表性查询及质量检查，再切换环境与发布版本；不要让不同维度共用活动 generation。索引损坏时保留原文和历史，运行重建任务，不能把损坏缓存直接标为 ready。

## 有界文件和结果核对

Markdown 上限 20 MiB；超过 1 MiB 或单行超过 32 KiB 使用 Web 片段模式。Web 正文单页最多 128 KiB；机器默认 8 KiB/100 行、最多 16 KiB/200 行。完整机器请求 128 KiB，完整双份兼容结果 64 KiB，密集转义可能使正文页进一步缩小；拒绝压缩请求。

快照每个身份 64 MiB、全局 256 MiB；机器会话 32 页/256 KiB/15 分钟、2 并发读取和 2 MiB/分钟。游标绑定身份、客户端、版本、位置和预算。UTF-8 BOM、CRLF 和 byte offset 保持原字节；已观察到 A→B→A 后旧游标也失效。历史正文、分享正文和下载同样受认证与版本约束；分享每页验证撤销，分享页不显示内部路径或私人索引状态。

patch 返回后台 operation，仅保存已加载范围，登记 range hash、mtime、全文哈希和原 requestId。文件任务排队和执行各有 300 秒 deadline。提交前可取消；进入 committing 后结果可能未知，此时必须按原 requestId 查询 `/api/operations` 或网关 `operation_status`，不生成新 ID 重做写入。写入与历史摘要不会回传正文。后台恢复确认已替换、未替换或外部冲突，保留幂等和历史证据。

研究类 search 为可完整获取的 note/chunk 签名对象生成 ID。fetch 校验当前授权、`sourceHash`、`sourceRevision` 和实际原文字节；整篇超过对象/JSON 预算时 search 选择片段对象，fetch 不截断整篇、不自动翻页或下载。

## 备份、恢复和回滚

暂停 Web、file/index worker、Git 拉取及外部编辑，按[部署与恢复](部署与恢复.md)执行 SQLite 一致性备份。保存原文、附件、回收站、业务数据和历史；模型、索引可从固定代码与模型清单重建，真实密钥另做受控加密备份。校验使用 64 KiB 流，备份过程检测原文变化；失败结果不能替代完整备份。

恢复只允许明确的空 `KNOWLEDGE_ROOT` 和 `DATA_ROOT`，旧数据保留回退。恢复核对 checksum 和 SQLite integrity，清除派生快照/索引、提升原文版本并重新核对根身份；未结束任务保留为需核对的证据。旧浏览器 session 删除、分享禁用、机器令牌发行时间截止写入持久数据；短期网关声明携带已验证原始 `tokenIssuedAt`，旧令牌或无法证明发行时间的令牌被拒绝。密码重置执行相同机器截止逻辑。重新认证/换发令牌后验证文本与语义查询，再重新建立确需公开的分享。

发布回滚先停止本次发布进程，保留原文、当前数据库与历史备份；切回已验证源码与环境。新增业务表为增量迁移，不直接使用旧数据库覆盖较新的写入。模型/索引空间不兼容则先重建派生数据；回滚不能恢复已撤销的旧授权。

## 验证和边界

运行 `npm test`、`npm run typecheck`、`npm run build`、`npm run test:e2e` 和 `runtime/vector-service/.venv/bin/python -m pytest runtime/vector-service/tests -q`。实际模型测试需要明确准备的本地模型；缺少模型时测试会标记 skip，不能把 skip 当作模型通过。性能命令和实测数据见[MCP 性能评测](MCP性能评测.md)，合成标签不等于人工金标准，未达标指标如实保留。

日志默认不记录原文、查询、向量或令牌。systemd 使用现有 journald 与主机既有保留规则；部署时记录发行者、发布 SHA、工作目录、用户、端口、数据和恢复副本。模板只提供可审查配置，未申请公网地址、修改实际 `/etc`、创建定时任务或完成 ChatGPT 账户接入。
