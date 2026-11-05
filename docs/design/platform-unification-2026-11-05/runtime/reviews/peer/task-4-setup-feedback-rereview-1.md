# Task 4 setup feedback — scoped re-review 1

固定对象：增量patch SHA256 `042f85180e7125b9407117ef51ae0889deb60555ca4fb9cca46c7f8f4f544ceb`，相对原633 package的5文件；同时用完整patch `d4029c0812bda07ceda10defa2d471f57180b7e96e6350de52453a4fd0ba0540` / fix1 manifest核对base551+最终9文件。源码行号指向 `/home/bandoo/.codex/worktrees/platform-modal-focus/doo-know` 的manifest版本。只复核两项Important及修复新增风险，不重审已接受的原633其他功能，不把main未集成状态当作实现结果。

## Strengths / 原问题处理

**1. 页面反馈越过活动modal抢焦/滚动：已解决。**

- `GitRemotePanel.vue:125`–:138识别实际可见modal，并将页面反馈限定为active、import、无自身overlay、无busy且无其他可见modal。:145–:158在nextTick执行时重新核对，且比较原error字符串、unresolved对象和resumed job身份，旧排队receipt不能改投新反馈或新凭据窗口。
- :163–:190增加独立credential错误目标。它只由凭据save、SSH请求错误及既有SSH信任校验触发；背景load错误没有调用该helper。因此背景status失败可以更新错误文字，但不会移动当前凭据输入焦点。
- helper重查active/busy/credential overlay/同一message、真实连接且有布局的target，检查当前surface与其他可见modal关系。只对目标focus(preventScroll)，再修改其`.settings-overlay-body.scrollTop`；没有对背景调用scrollIntoView。真实global reauth或另一个modal不会被它越过。未修改SettingsOverlay/global focus trap。
- 现有owner/receipt guard仍在响应提交处执行；本轮未改start/reconcile/poll/retry/cancel的durable ID、CAS、完成通知去重或session-stopped流程。调度的额外snapshot检查是UI防护，未取代原协议守卫。

**2. FINISH-IMPORT-RACE：已解决。**

- `SetupWizard.vue:443`只将自己的finish busy传给子级disabled；`SetupImport.vue:27` / :35同时拒绝parent-locked状态的select/upload，:107 / :116同步禁用native file input和confirm。已选File与requestId不会因lock变化清除。
- 反向仍由原child local busy→parent importBusy阻断两种finish intent和上一步。子级busy事件只报告自身请求状态，不报告`disabled || busy`；所以父busy不会经子事件回灌形成自锁。finish失败finally清busy后，child自然解锁，原file和请求重试身份仍保留；已接受的import则持续锁finish到真实结果返回。
- optional disabled prop不改变Workspace中其他SetupImport调用的既有行为。256KiB检查、UTF-8、folder/note请求、requestId在确定4xx后的重建规则和不覆盖语义均未改变。

## Issues

### Critical (Must Fix)

无。

### Important (Should Fix)

无新增问题；上述两项已在本次固定范围内处理。

### Minor (Nice to Have)

无。

## Recommendations

将本次通过限定在固定package和已报告测试分支。root整合后继续最终source-bound复验与原视觉席位的逐图检查；使用full patch，或原633+incremental，不能两种路径重复套用。无需再扩大本轮协议/布局重构或重复同源码测试。

## Review evidence / limits

- 已完整读取本轮5文件incremental diff、原审查、原报告round1追加内容、fix1 manifest，以及runtime rereview中新FINISH-IMPORT-RACE的来源/影响。完整patch用于确认增量归属；最终9文件hash全部与实现树匹配，HEAD仍55174。
- 独立计算incremental/full patch SHA256均符合给定值；原633 patch与原manifest hash仍匹配。独立执行两份patch的`git apply --reverse --check`及`git diff --check`，均exit0；这些命令只有检查，没有应用、stage或其他Git写入。
- 已读新3unit RED日志，覆盖parent disabled时零API、排队后overlay打开、旧receipt不能重复/改投focus；已读browser RED，四个真实产品失败为save/SSH错误焦点、延迟背景status抢焦及finish期间子file仍可用。global auth最初的“自动聚焦username”是假设错误，修正测试后在原633就通过，报告没有冒称修复了global auth业务。
- 已读GREEN日志：4文件/68unit passed、36个真实三宽E2E passed、typecheck最终无错误；额外相同handler三宽child-controls为3passed，另一次typecheck无错误。沿用作者已执行结果，**本次没有重跑这些测试**。child-controls那次数字exit handle未保留的限制继续保留，不用日志summary冒充捕获到exit receipt。
- 新browser断言直接检查当前modal error focus、非首项credential输入保留、背景scroll不变、真实App/api401/compact global reauth、零额外note/folder/finish写入、失败后同一File和真实disk内容。记录额外两个capture语句没有改变product或测试分支。
- manifest登记36case run的48张PNG与child-controls3case的9张PNG；逐图视觉复核由root安排，本审查没有用设计图或静态源码代替运行截图，也未将作者worktree截图称为最终集成产物。
- 未启动server/browser，未运行unit/E2E/type/build/full suite，未修改源码、Git index/HEAD/分支、服务或真实数据。唯一写入为本报告。

## Declined to judge / residual boundaries

- 本轮57张新图及原27图的逐图视觉接受、最终集成后的真实focus/hit/scroll与源码绑定：由root后续同视觉席位/最终source验证完成，本代码审查不替代。
- global auth成功重新登录、不同owner切换、物理键盘/原生文件选择器：新真实测试证明的是过期后modal的焦点/背景边界，没有覆盖这些额外流程，不扩展为已通过。
- 非当前用户错误的后台信息是否主动聚焦、accepted异步SSH任务所有后续状态的专用定位体验：本轮明确避免背景事件抢焦，保留原状态和消息；没有要求所有后台变化自动移动焦点，也未新增该能力。
- 原CLIPPED-PROBE/INNER-INPUT、全平台暗色/短横屏/SSR/blog/export、release/服务部署：不属于本次两项fix的范围和证据。
- 原633已接受的registry、精确byte、恢复job身份、按钮命名与spinner/glyph等：本轮源未改变，未重开审查；相关原18case仍包含在当前36case报告中。

## Assessment

**Spec alignment:** 通过本次scoped复核。页面与modal的焦点/滚动所有者分开，排队反馈执行时重核对当前状态，parent/child双向操作锁和失败后保留选择均落实两项Important要求。

**Code quality:** 修复集中，没有新协议字段、权限、真实成功造假或请求ID/CAS退化；未发现新Critical/Important/Minor。双向锁没有自锁回路。

**Ready to merge? Yes（本固定修复范围）。**

**Reasoning:** 两项Important已解决，现有新RED→GREEN证据覆盖实际触发和关键调度边界。可进入root集成与最终source/视觉复验；此结论不是全平台或最终发布验收。
