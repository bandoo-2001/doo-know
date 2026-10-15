# DooKnow 第一批一致性修复计划

Goal：仅修复 W01、W02、W03；依据知识库审查报告与本次启动授权。
Architecture：保持 Vue/Fastify/SQLite 技术栈，复用 operations/write_intents 与启动 recover。故障测试使用临时目录和子进程，源码在当前干净工作区修改，复用已有 /tmp 隔离证据。

约束：不提交推送、部署、启停生产服务、改生产配置或 Bridge；不改原报告及真实笔记。

- [x] W01：tests/knowledge/p1-consistency.test.ts 复现长行提交后 409；server/notes.ts 返回写入回执与必要的 metadataOnly，提交内容提供模式元信息，避免提交后再次读取导致假失败；Workspace.vue 按成功模式切换并按业务码处理冲突。覆盖阈值、丢失响应核对、非版本 409。
- [x] W02：同测试复现旧版本删除和分享撤销；recovery.ts/app.ts 接收页面版本和稳定 requestId；Workspace.vue 保存待核对删除状态。覆盖跨端更新、重复请求、失败不撤销分享、响应丢失。
- [x] W03：tests/knowledge/restore-crash.test.ts 与隔离子进程覆盖复制、数据库、unlink、提交窗口；core.ts 持久化 restore 意图并校验源/目标证据后重放；notes.scan 保留待核对目标身份；recovery/app/UI 接入 requestId。覆盖占位、异步外部变更、幂等、历史、分享、大文件。
- [x] 运行必要回归、typecheck、build 与浏览器验证，复核实际 diff；验收记录写到知识库指定文件，其他批次明确待授权。

审查重点：操作结果未知时保留 requestId；不能覆盖占用路径；不能撤销失败删除的分享；恢复冲突不能产生新身份；成功后模式切换不能丢草稿或错误归为版本冲突。

执行方式：按用户要求在本会话直接执行，不等待重复启动确认；每项先失败再修复。禁止 Git 提交覆盖技能的默认提交步骤。

实施裁决：独立复核发现的路径占用、独立副本保留、索引身份、根 README、提交后回读和双向模式转换均属本批一致性要求，已补正式回归。保留现有架构；当前工作区干净起步，所有故障夹具在临时目录隔离，未另建或切换 Git 工作树。

最终验证：Web 62 文件 / 163 条、Bridge 10 文件 / 34 条通过；相关浏览器 desktop 12 + mobile 12、预算补充后的 P1 desktop 4 + mobile 4 全部通过；typecheck、build、diff 与格式检查通过。恢复哈希沿用 64 KiB I/O 块，相关预算用例先红后绿。一次桌面检索等待超时的原始失败与相同命令复跑结果均保留在验收记录中，未修改搜索实现或宣称定位该偶发超时。构建仍提示主包大于 500 kB。完整命令、历史失败与未覆盖边界已写入知识库指定验收记录。禁止提交推送及生产操作的约束保持有效。
