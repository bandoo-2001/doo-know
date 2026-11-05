# Task 2 第三轮修复复核

**标题往返问题：ADDRESSED。本轮增量可以集成。** 两个文件的基线 SHA256 匹配 fix2 终态，隔离工作树文件匹配 fix3 manifest 的最终 SHA256。

- `apps/web/diagrams/document-draft.ts:20–39` 在有 pending 时优先导出完整记录。对可解析的图形，决定导出格式时会比较当前 Markdown 标题和当前会话标题。原生根题从 B 改回基线 A、正文仍含 B 时，两者不一致，于是 v2 JSON 保留 A、带 B 的整篇正文及原生子树。这个判断覆盖了上轮遗留的往返场景。
- `tests/diagram-recovery-download.test.ts:105–123` 使用有效脑图 fixture，保持原始子树字节，并验证 A、临时 Markdown 标题 B 和新增说明均在导出数据中。对只有不完整 Markdown 输入、标题和原件没有独立变更的情形，配对用例逐字验证原始 .md 内容。
- 已核读已有日志。fix2 下聚焦 RED 为往返用例失败、原文保全用例通过、另 13 个用例被筛选；修复后相关 5 个文件 42/42 通过。原生格式、独立正文、held v2 与 pending 等已有对照仍在该组测试内。fix1 单独的 6/6 浏览器结果沿用其对应源码范围。
- 在本次两文件增量内未发现新增 Critical、Important 或 Minor 问题。该轮仅改变下载格式选择，不涉及 UI、保存控制器或 JSON 导入。此次复核未启动服务、重跑测试或修改源码与 Git 状态。fix1 → fix2 → fix3 的最终集成、真实截图和集成源码回归仍由 root 执行。
