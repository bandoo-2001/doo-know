# 首次设置真实截屏审查

应用源 55174d48cd4dc6c315d7595d982749994ad1cdbe。逐图文件、SHA-256、所看图稿、控件图和异常在 docs/design/platform-unification-2026-11-05/runtime/reviews/setup-public-review.json。

44 场景 × 3 宽度，132 个实际窗口和相应 132 个控件窗口分别查看。首次批次 120 个有效窗口，12 个旧流程失败仅列 sidecar；4 个场景用同源的三宽补采。

判定 {'pass-with-observations': 66, 'pass': 49, 'needs-revision': 17}。公开入口未出现私人栏；进入新建笔记的私有工作区是完成绑定后的预期状态。

- SOURCE-CUE（design-deviation，33 个窗口） 来源选择卡只有前景、底色和细边框颜色表达选中。MP-D078/R046/R047/R048 给出独立的勾或选中标记，产品源码已有 aria-pressed。
- GIT-FEEDBACK（needs-revision，4 个窗口） 提交后停在长表单底部。手机主图和控件图均无该次结果、核对或重试操作。错误在页面更高处，仅向上滚动可找到。
- RECEIPT-ACTION（needs-revision，3 个窗口） 已有未确认请求时，主按钮仍是“导入并继续”，实际点击走 startJob 的 unresolved → reconcile。核对操作和按钮名称不同。
- RESUMED-JOB（needs-revision，3 个窗口） 恢复已接受的 clone 后任务卡未标明仓库，禁用 URL 为空、名称恢复“我的知识库”，无法识别正在下载哪个库。
- UNAVAILABLE（needs-revision，3 个窗口） 注册表暂时读失败时同时显示“暂未提供此功能”与启用的“添加”按钮。可用性未知却显示成不可用；按钮仍会尝试安装。
- FILE-PRECISION（needs-revision，3 个窗口） 262145 字节显示 256.0 KiB，与页面“不超过 256 KiB”的规则及超限错误同屏矛盾。
- SMALL-FILE（design-deviation，18 个窗口） 非空小文件的大小回执显示 0.0 KiB，用户无法区分它和空文件。
- FINISH-SPINNERS（needs-revision，3 个窗口） 只选择了进入工作区，但创建笔记与进入工作区同时显示极浅的 spinner。两个动作均须锁住，只有当前请求应标明执行中。
- CLIPPED-PROBE（evidence-limit，3 个窗口） 目录控件探针上限为 160，实际找到 208；页面确有截断和路径回退，不能宣称已量测其余每一个控件。
- INNER-INPUT（evidence-limit，9 个窗口） 透明 Ant combobox input centerHit=false，输入可获焦。未看到其他控件遮挡，recipe 未验证该下拉的选择动作；本表不认证其指针操作。
- STATUS-CTA（design-deviation，6 个窗口） 检查/重试是该阶段唯一可用的主操作，但实际为白底细边，与 MP-D085 蓝色主操作层级不同。

本轮只审图、读取已有 sidecar 和源代码，不含外部平台、物理键盘、系统文件选择器或全量页面状态认证。
