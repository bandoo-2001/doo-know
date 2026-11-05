# WS / RTD 最终视觉修复第一轮复核

**结论：With fixes。** 原两项 Important 均已就其原始复现得到解决；本轮引入的一项同窗口恢复错误需修正。四文件增量的基线与前一轮终态相符，最终十一文件 SHA256 与实际主工作树相符。

| 原项 | 判定 | 依据 |
| --- | --- | --- |
| 大脑图初次整体缩放导致根出屏/文字过小 | **ADDRESSED** | `apps/web/diagrams/mindmap.ts:77–86` 先检查拟用比例对实际主题字号的影响及库的最小缩放；不满足 12px 时保留原先根居中的正常视图。24 级合法深链的真实保存、挂载测试覆盖根在屏内、有效字号、平移到第 24 级、平移后稳定、服务端和下载字节相同。之前两节点长根的完整显示与平移控制仍通过。 |
| 取消触发外层表单提交及同一创建意图的相反决策并发 | **ADDRESSED** | `apps/web/components/Workspace.vue:1639–1674,3765–3767` 的两个显式 type=button 不参与默认表单提交，取消/恢复同步持有 createBusy，另一决策及普通表单创建受锁。针对性浏览器用例记录真实 POST/GET/DELETE/commit 并在响应停留时检查，两种取消失败仍保留同一指针和 IDB 草稿；成功发布后末次 note GET 丢失可通过缺失指针分支重试，仅提交一次。 |

## 本轮新增的重要问题

**同一恢复请求正常取得服务端 ID 后，仍留在当前弹窗的用户可能失去恢复和取消入口。** `apps/web/components/Workspace.vue:1632–1637,1654–1657` 对 intentId、noteId 一律严格相等；失败回调只展示错误。这里 ID 是分阶段获得的。首次创建预写本地 descriptor 后 reserve 未送达，外层捕获会把没有两个 ID 的 descriptor 放入 unfinishedCreation（1730 行）。第一次点恢复，若 reserve 成功，coordinator 会把两个实际 ID 写入同一 descriptor（`apps/web/diagrams/primary-creation.ts:78–86`）；随后 prepare 失败，UI 仍持原来缺 ID 的快照。再次点击恢复或取消，本轮新判断将这个同 requestId、同 path/type/title 的正常进展误判为另一个操作并拒绝，直到手动关闭重开。测试中的 pendingOrdinaryForm 从成功 reserve、首次 prepare 失败开始，持有的两个 ID 始终已知，因此 14 个现有通过项不覆盖上述顺序。

建议只允许在同一作用域、requestId/path/type/title 相同时从未获配 ID 补全到实际 ID；已知 ID 的变更或不同目标仍应拒绝。也可在恢复失败后仅同步可证明是同一目标的单向补全。继续保留原有 published/direct-note-read 的指针缺失特例，不应新增服务器 API 或跨 tab 协调。最小真实回归可依次只阻断一次 reserve、一次后续 prepare，事件间保持同一已打开的弹窗，再次恢复应成功且只发布一次，或取消实际已获配的同一 intent 并保留表单。若另一个 requestId 替代目标，仍需拒绝操作。

## 证据与界限

- 原五个 RED 和“已发布末次读取丢失”的独立 RED 继续保留。该场景前一份选择器冲突日志仅为 setup 失败。已核读最终 14/14、独立适配器 2/2、8 文件 110/110；typecheck 据执行记录退出 0。本席未重跑测试/浏览器/服务，未变更产品或 Git 状态。
- 这项新发现发生在同一窗口、同一个 requestId。跨窗口强 CAS、既有 coordinator 的原子性与其他创建入口不属本次增量。上轮 Minor 的无 HEX 弹窗时布局读取按交付协调人的裁定暂缓；没有新增性能实测结论。
- 目标源码分支合并、冻结和实际 after 图片验收仍由交付协调人进行。真实深链案例的局部交互证据不能替代逐图审查。
