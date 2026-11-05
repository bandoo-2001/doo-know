# Task 3 — SettingsOverlay focus 修复 scoped re-review

范围：`task-3-focus-fix.patch`（相对 `12b7798` 的完整两文件包）及 `task-3-focus-fix-report.md`。生产修复位于独立树 `/home/bandoo/.codex/worktrees/platform-modal-focus/doo-know`；main 的 `12b` freeze 尚未 apply 此补丁。本次只读取补丁、fixed source、锁定依赖及已有测试/DOM evidence；唯一写入为本报告，没有运行 git、修改源码、启动服务器/浏览器、重跑测试或派生代理。

## Strengths

- **根因与修复直接对应。** 锁定 `vueuc/es/focus-trap/src/index.js` 的 `getMainEl()` 从开始哨兵向后查找，只有 `tagName === 'DIV'` 才停止；`resetFocusTo()` 又会在选中结束哨兵时将焦点拉回开始哨兵。Naive `modal/src/BodyWrapper.mjs:246` 把自定义 slot 根直接放在 VFocusTrap 中，因此原 SECTION 确实无法成为 focus main element。`SettingsOverlay.vue:102` 仅将其改成 DIV，并保留依赖约束注释，符合真实依赖契约。
- **没有通过停用 trap 绕过问题。** `trap-focus`、`auto-focus`、`role="dialog"`、`aria-modal`、label/busy、tabindex、surface ref、class、width 和 header/body/footer 均保持。现有样式按 class 定位，root tag 变化不删除原布局与可访问性语义。
- **关闭与 popup 契约保持。** close/discard 的 busy early return、dirty 二次确认、`mask-closable` / `close-on-esc`、进入后首字段焦点、离开后触发按钮返回焦点，以及 Git 切换 drawer/modal 时 `left()` 的 `props.show` 保护均原样；Ant popup 仍通过最近 `.settings-overlay` / surface 归入实际焦点范围。NDrawer 自有 DIV 包裹，内层 root 改成 DIV 与该结构兼容。
- **新增回归测试命中真实失败。** `tests/e2e/settings-overlay-focus.spec.ts:41` 的密码路径与 `:194` 的 Git 凭据 modal 路径使用 `page.keyboard.type`、首字段焦点和前后 Tab，而非只靠 fill；并断言首尾焦点不外泄、外部程序焦点被挡、dirty 继续/放弃/重开清空与返回焦点。`:111` 覆盖被真实请求挂起的 busy Escape/遮罩守卫，`:159` 覆盖 drawer 内 Ant popup 选择及键盘焦点。mutation 计数与拦截的拒绝请求避免把实际密码/凭据写入当作测试需求。

## Issues introduced by this patch

### Critical (Must Fix)

无。

### Important (Should Fix)

无。

### Minor (Nice to Have)

无。

## Evidence and exact test status

以下结果来自此次实现者留下的日志/JSON，审查者未重跑：

- 最终清洁 RED：新增 12 项中 **6 fail / 6 pass**；六个失败为 320/390/1440 三尺寸下的密码 modal 与 Git credential modal。已读 `task-3-focus-fix-red-verified.log` 的失败名单，和报告的根因一致。
- GREEN 合跑：新增 focus spec 两项目 **24/24 pass**；原 SettingsOverlay spec 两项目 **18/22 pass**；总计 **42/46 pass，4 fail，命令 exit 1**，不是全绿。
- 四个失败为既有测试文件中的两个不同用例，各在 desktop/mobile 失败一次：`settings-overlays.spec.ts:338` 密码图标精确颜色断言，以及 `:409` 等待 `Markdown 源码` 按钮超时。读取旧测试可见前者仅直接改 HTML `data-theme`，没有切换 preferences/resolved provider；后者在进入 overlay 前已失败。本补丁未改这两个用例。没有本轮相同旧用例的修复前基线，因此不把它们声称为已经证明的“预先存在产品失败”，也不把它们从总结果扣除。
- 真实 dark probe 使用 `preferences.setEditorPreferences({ theme:'dark' })`，记录 preference/resolved/HTML 均为 dark；360×460 下 dialog 为 `{x:12,y:12,width:336,height:436}`，body 有内部滚动，footer 可见，三字段真实键盘输入、末字段焦点与 dirty 放弃后触发按钮焦点均通过。已读 probe 脚本与 `task-3-focus-fix-true-dark.json`，合成透明度后的已采样文字最低 **5.82095:1**、三个密码图标最低 **4.40215:1**。这支持真实 provider-dark 场景的可读性，不等于旧精确色值测试已修复。
- typecheck 修复前后均报告 exit 0；patch 的正向 main apply-check / fixed tree reverse-check 与 diff-check 均报告通过。这些结果不代表补丁已被 main 应用。
- 被 root 中止的 `npm test` 是 exit 130 的 partial run，保留了失败/中断记录，不能作为完整单测通过或完整失败矩阵。

## Recommendations

- 可接受该最小 root-tag 修复及新增焦点回归，按 root 的 freeze/integration 安排应用后执行集中验收。
- 保留 42/46 的精确结果，并在 root 的测试维护范围内分别校准真实 theme provider 前置条件、语义可读性断言和现有 Markdown 编辑入口。不要为消除两个旧测试失败恢复会覆盖 provider/disabled/error 语义的局部色值规则。

## Declined to judge

- main apply 后的集中 runtime/type/build/全套回归与发行：当前 main 尚未合入，且本次明确禁止重跑环境；本结论仅评价已提供的独立树修复。
- 两个既有失败用例的完整业务链：一个主题前置条件不完整，一个未进入 overlay；修正测试/验证完整“返回保存”链不在本 root-tag patch 内，仍需 root 处理并记录结果。
- 所有 SettingsOverlay 消费者、屏幕阅读器、全部浏览器/输入法/主题组合的穷举验证：新增用例与 probe 覆盖上述明确场景，未覆盖部分不据此声明通过。
- 其它 Task 3 视觉、长凭据与语义文字修复：延续前两次 scoped review，不在此次重复开展全模块审查。

## Assessment

**Spec alignment:** 通过本次 scoped 修复审查。恢复 modal 的真实键盘输入与焦点约束，同时保留既有 dirty/busy、Ant popup 及 drawer→modal→drawer 草稿/返回链契约。

**Code quality:** 最小且可解释的兼容修复，新增测试使用真实控件和真实键盘输入，能区分 fill 可设值与实际无法输入的原故障；无发现 patch 引入的新问题。

**Ready to merge? Yes（该两文件 scoped patch）。**

**Reasoning:** 依赖源码与独立树 RED→GREEN evidence 一致支持 SECTION→DIV 修复。整组合跑仍为 42/46；此批准不等于 main 已应用、旧四项失败已解决或平台最终验收全绿。
