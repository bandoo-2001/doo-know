# 知识图谱实现参考与取舍

调研日期：2026-10-29。调研后继续在现有 Vue、Cytoscape、Fastify、SQLite 架构内实现，没有引入外部整套应用或复制其源码。

| 官方/原始资料 | 采用的思路 | 本项目的明确区别 |
| --- | --- | --- |
| [Obsidian Graph view](https://obsidian.md/help/plugins/graph) | 笔记引用网络、局部深度和孤立项 | 保留引用视图，另外增加正文概念和模型关系 |
| [Microsoft GraphRAG dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/) | 分块、实体/关系、原文 TextUnit 溯源 | 采用现有笔记身份、原文版本和轻量持久队列，不安装其完整 Python 管线 |
| [LightRAG](https://github.com/HKUDS/LightRAG) | 增量维护、选择性删除、实体关系与模型适配分离 | 内置于宿主，不新增图数据库或常驻服务 |
| [InfraNodus interface](https://infranodus.com/tutorial/interface) | 概念共现、选中对象后回到原文，按选择深入探索 | 不同时铺开多个分析面板；采用一画布、按需详情和独立覆盖层 |
| [Smart Connections](https://smartconnections.app/docs/connections/) | 从当前内容发现相关资料，并检查来源后决定是否形成正式链接 | 首版相似度明确是词项线索，不伪装向量语义概率或自动写回链接 |
| [Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs) | 原生 chat/结构化输出、本地模型接入 | 模型运行和下载由用户现有服务负责，本应用提供统一配置和验证 |
| [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat) | JSON Schema 与 JSON 模式、受约束输出 | 支持兼容协议，不预设实际模型/账号，不把协议测试描述为实际服务验收 |

## 本轮设计判断

显式引用图有成熟产品先例，但不能等同于语义实体图。两者分开呈现；本地共现、词项相似和模型关系各自保留方法标记，只有真实原文能成为证据。模型候选经过人工整理，不把模型分数当事实概率。

自动更新通过来源变更、独立后台队列和来源版本围栏实现。缓存与可重建结果放运行数据；人工决定放知识库便携域。模型、网络和分词组件暂不可用时，不影响普通笔记编辑。

默认页面限制信息密度：80 节点/120 条边、重要标签优先、画布与列表互斥、详情按选中展开。管理任务、模型和审核放独立面板。每项限制都属于本项目在 Mini 主机上的资源与交互取舍，不称为行业统一标准。

模型 API 实现按照官方接口字段独立适配，使用合成 HTTP 服务测试取消、大小限制、密钥边界、原文证据和引用，不发送真实用户笔记。实际模型质量需配置后评估。
