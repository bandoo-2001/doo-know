# To Doo 功能可发现性、布局与颜色验收

## 实现

- 桌面导航按我的待办、计划与执行、专注与生活、回顾与管理、我的清单分组直接展示；移除折叠的“更多功能”。导航提取为共享组件，手机功能抽屉使用同一份入口、清单分页与事件。
- 手机保留原有页面/清单选择器，增加日历、四象限、专注、习惯快捷入口；完整抽屉具有中文名称、关闭按钮、模态语义、首尾 Tab 和 Escape 处理，关闭后恢复入口焦点。有未保存确认或其他编辑面板时优先聚焦当前可见确认面板。
- 收紧页头、输入与工具栏留白，解除统一最大宽度；矩阵利用可用高度，各格独立滚动，小屏纵向排列。
- 四象限使用红、橙、蓝、绿和“立即行动、安排计划、协调处理、留待以后”，配合文字说明与空态指导。日期不再隐藏。
- 高/中/低/无优先级统一为红/橙/蓝/中性色，任务行、看板、详情一致；保留文字，不依赖颜色。重要/紧急设置移到直接可见的“四象限归类”，不改变实体语义。
- 按需使用 Ant Design Vue Button、Drawer、Segmented、Select、Tag；保留全局 ConfigProvider 与深色主题，不安装新依赖。
- 同步修复快速添加的 Q 快捷键：只有可见模态面板阻止快捷键，隐藏或已关闭的抽屉不再拦截。

## 设计依据

使用官方文档研究现有产品的具体工作流程，并在本项目数据语义下应用，而非复制页面：

- [Todoist：侧栏与导航](https://www.todoist.com/help/articles/customize-the-sidebar-and-navigation-menu-in-todoist-S9JLTYqZV)
- [Todoist：优先级](https://www.todoist.com/help/articles/set-a-priority-in-todoist-Wy82Jp)
- [TickTick：四象限使用](https://help.ticktick.com/articles/7055782055577124864)
- [Things：任务组织与日常流程](https://culturedcode.com/things/guide/)

具体矩阵配色与中文行动提示为本项目设计决定；任务 priority 与 importance/urgentOverride 仍是独立属性。

## 验证与边界

- 定向单元：5 文件、48 项通过，覆盖导航、快速添加草稿与日期、工作台、任务呈现及应用快捷入口。
- 浏览器：原有任务/目标创建、保存、附件、完成、筛选、草稿恢复、清单、专注/习惯/纪念日、CSV、成果笔记、批量/整树操作及应用切换已在桌面、手机通过。最终导航/快速添加定向复核为桌面 8/8、手机 8/8，包含可见导航、320px 深色、四象限、优先级真实保存、Tab/Escape/Q 和取消离开保留草稿；日志为本聊天 artifacts 中 `todoo-final-verified.log`（退出 0）。
- 类型检查与构建成功；保留已有第三方模块指令构建提示。
- 独立审查指出的 Drawer 模态语义、焦点循环和确认面板优先级已修复；浏览器回归曾发现隐藏抽屉拦截 Q，也已同步修复并增加回归。
- 真实 `http://100.93.35.65:5180` 开发预览只读验证：四个区域正常、无浏览器运行错误、手机无横向溢出；没有写入用户任务、重置账号或修改正式服务。
- 额外尝试全项目 `npm test`，未完成全绿验收。约 17 分钟后停止本任务的全量运行（退出 130），期间出现 `git-containment-failure.test.ts`、`git-guarded-timeout.test.ts` 超时以及 `e2e-server-lifecycle.test.ts` 的夹具清理失败。同时存在其他任务的全量 Vitest，且生命周期测试与浏览器检查使用固定端口/夹具文件，因此此轮不用于判断 UI 回归。没有修改这些无关 Git/进程实现或停止其他任务。详细失败名称和原始输出保存在 `todoo-full-unit.log`，不能据此声称全项目测试通过。

## 位置与状态

主要修改为 `apps/web/components/ToDooWorkspace.vue`、`components/to-doo/ToDooNavigation.vue`、`ToDooTaskViews.vue`、`ToDooTaskRow.vue`、`ToDooTaskDetail.vue`、`ToDooQuickAdd.vue`、`apps/web/to-doo.css` 和 `to-doo-priority.css`。使用说明与相关浏览器定位同步更新。

工作在原有隔离工作区完成，保留先前未提交修改；本次没有提交、推送或发布到正式实例。开发预览直接读取当前源码。基线、研究、审查、日志和截图保存在本聊天的 visualization 目录；带任务截图使用独立临时测试数据。
