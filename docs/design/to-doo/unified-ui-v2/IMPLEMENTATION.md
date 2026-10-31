# To Doo 统一 UI：规范、覆盖与验收入口

状态：UI统一验收完成；本轮后台性能修复与功能回归已通过，当前截图已刷新验证，真机推送送达待用户设备确认。最新结果见[补查记录](FOLLOWUP-2026-10-31.md)与[补查验收](verification/followup-acceptance.json)。最终证据：[验收汇总](verification/acceptance.json) · [实际UI图册](verification/current-ui/index.html) · [截图索引](verification/current-ui/index.md)。设计图入口为 [README](README.md)，最终图片以 [selected-images.json](selected-images.json) 为准。用户目标文件已完整读取；本页是开发决策、功能覆盖与验证证据的唯一入口，实施步骤见 [实施计划](../../../superpowers/plans/2026-10-30-to-doo-unified-ui.md)。

## 约束与当前基线

- 在当前已隔离工作树 `/home/bandoo/workspace/projects/doo-know` 实施，分支 `txj/release-rc58`；保留已有未提交修改。不开另一份遗失现有修复的工作树，不部署、不读写真实用户记录或凭据。
- Vue 3 / TypeScript / Ant Design Vue 4.2.6 / Fastify / SQLite / 可携带实体文件继续作为现有架构。默认显式保存；失败保留草稿，requestId 重试幂等，expectedRevision 检测冲突。
- 本次开始时已有列表/详情简化、日期边界修复和 AntDV 值适配；这些属于待回归的基线，旧验收记录不能充当本次通过证据。
- 发现：工作区默认每集合 200 条、focusSession 按 rowid 早到先读，活动计时及今日历史依赖该工作集。复盘图表最多 31 天。核心与 MCP 分别计算统计，需统一且保留授权范围。
- 早期基线为379文件2723项通过、1项既有跳过；最终全仓为385文件2770项通过。最后纯提醒UI改动后的51文件450项复测单列，完整证据见末尾。

## 唯一布局规范

`ToDooWorkspace.vue` 是所有 To Doo 页面共同的 AppShell，宿主的 `WorkspaceMainMenu` 提供唯一一级菜单；页面不得另建全局外壳。

| Token / 区域 | 桌面规则 | 手机规则 |
| --- | --- | --- |
| 一级主菜单 | 64px，图标在上、短标签在下 | 复用宿主底部导航和更多，不叠加一套 |
| 全局顶栏 | 56px，跨所有内容列；品牌、面包屑、全局操作固定位置 | 同高度，收起次要说明，保留目录入口 |
| 上下文目录 | 180px；任务/看板/目标为任务组，日历周/月/时间线为日历组；位于顶栏下方 | 使用 AntDV Drawer，关闭和选项有焦点恢复 |
| 页标题 | 共享 PageHeader：标题、说明、主要操作；同一基线 | 长标题换行，操作可换行 |
| 页工具栏 | 共享 PageToolbar；视图、筛选、查询、次要操作 | 自适应换行，不挤出横向页面滚动 |
| 详情 | 420px，位于顶栏下方；低于 1280px 为覆盖面板 | 避开底部导航与安全区，保持草稿和键盘操作 |
| 内容 | 24px 内边距、8px 间距体系，列表阅读宽度最多 960px | 统一 16px，320px 仍可操作 |
| 主题 | 同一字体、颜色、边框、圆角和 AntDV ConfigProvider | 深浅色均验证，不用图片色值逐页覆盖 |

主菜单顺序：任务、日历、四象限、专注、习惯、纪念日、复盘；底部通知、设置。无上下文目录的页面自然占满内容空间。任务日期中的计划和截止分开，优先级与重要/紧急独立，默认空信息不占视觉位置。

共享组件职责：PageHeader 负责标题/操作；PageToolbar 负责工具布局；ContextSidebar 沿用 `ToDooNavigation` 的真实目录；SectionHeader 负责内容分组；TaskRow 沿用轻量任务行；DetailPanel 沿用任务阅读/编辑面板；FormLayout 负责表单分组和错误定位，具体实体校验留在实体边界。只抽取重复结构，不创建万能实体表单。

## 功能与 UI / API / MCP 覆盖表

状态解释：已实现且自动验证 = 下方有当前代码相关领域/浏览器证据；待人工验证 = 需要真实设备或部署环境。完整全仓单测与最后纯UI改动后的增量复测分别记录，不混淆源码版本。

| 页面/操作 | 实现与保留能力 | 模型 / HTTP | MCP 联动 | 测试与状态 |
| --- | --- | --- | --- | --- |
| 13主视图 / 4手机状态 | 统一共享外壳、标题、主要操作、主题；有无目录按分组解释 | 既有导航/页面状态 | 不适用：布局不新增工具 | 已实现且自动验证；最终169场景、46张原生截图、156次跨页几何通过 |
| 列表/详情/看板/四象限 | 轻量任务行与详情；创建/状态/子任务/重复/依赖/批量/资料/附件/成果/筛选/草稿保留 | task/occurrence/timeBlock/outcome；state/commands/outcome-note | 现有领域命令、资源/CAS/幂等 | task-surfaces、domain-regressions、detail-audit、ux、to-doo浏览器；已实现且自动验证 |
| 目标/清单及管理 | 任务项进度；模板/保存视图/归档回收与恢复可达 | list/template/view/plan/activity；state/commands | 所有嵌套清单及任务/安排引用授权；查询前过滤 | linked-resources、planning、full-core；已实现且自动验证 |
| 日历周/月/时间线 | 统一真实查询范围；独立计划/截止；全天末日不含、DST、外部只读；农历事件同源 | timeBlock/calendarEvent/source/feed | 沿用日历、时间安排、授权命令 | calendar-range、anniversaries、calendar-surfaces、interop；已实现且自动验证 |
| 专注项目与归档 | 持久主题、可选任务、归档；会话名称快照；旧数据/复制/完整恢复 | focusTopic/focusSession；state/commands | 既有实体发现/保存/生命周期/导出恢复 | focus-history、interop、full-schema；已实现且自动验证 |
| 专注历史与计时 | 1205+记录、最近键集分页、活动独立查询、日期/项目筛选、完整累计；中断继续、跨窗备注冲突 | focus/history + 领域命令；分段计时 | focusOverview需focus+statistics；过滤不改变授权；nextBreak沿用配置 | focus-history、statistics-parity、浏览器；独立审阅修复及最终分组回归通过 |
| 习惯 | 今天卡片/历史；数量、有效规则版本、日与周月累计分开；跳过/撤销/暂停/连续记录全页读取 | habit/habitEntry/ruleVersions | localDate分页前过滤；跳过0和普通正数同源契约 | habit-history、rhythm-controls、habit-cards浏览器；已实现且自动验证 |
| 纪念日 | 农历原始文本/下一公历分开、闰月缺失语义明确；UI/日历/提醒共用算法 | anniversary；shared/to-doo-anniversaries | schema兼容、实体读写不变；调度与UI同口径 | anniversaries、forms、notifications、calendar；已实现且自动验证 |
| 统计与复盘 | 授权核心聚合、完整区间趋势；累计目标独立；保存时捕获最终区间 | review/record/outcome；statistics | 捕获需statistics+records，不能聚合未授权记录 | statistics-parity、review-period、routes；已实现且自动验证 |
| 通知 | 六状态、日期分组/来源、最近分页、真正全部已读；错误反馈和设备管理保留 | reminderEvent/push/source/commands | source需来源权限；read_reminders最多500 ID，不降低已处理状态 | notification-query、reminders、push、history浏览器；模拟验证已做，真实推送待人工 |
| 设置与恢复 | 偏好/提醒连接/数据恢复/清单管理；默认视图；预览确认/分批恢复/导出/知识关联保留 | settings/operation/all portable entities | 既有settings/集成/导入导出/知识权限 | forms/default-view/interop/full-core；已实现且自动验证 |
| 六类编辑面板 | 任务/习惯/纪念日/安排/成果/复盘；Ant Form禁用上下文、隐藏错误定位、无效日期保留、null/false/0/多选 | 既有实体与命令 | 纯结构无需工具；契约修复UI/HTTP/MCP同源 | forms/antdv-values/outcome-ownership + 12深浅色截图；已实现且自动验证 |
| 宿主其他应用 | To Doo样式隔离；共享一级菜单；页面懒加载/错误重试 | 宿主路由/菜单 | 不适用：纯界面 | hosted-navigation、app-main-menu/shortcuts、notes/blog/responsive；最终分组回归通过 |

完整任务范围还包括：取消不写入、输入法和键盘、失败重试、连续操作/冲突、隐藏校验、长标题/空态/加载/错误、大数据分页、旧数据/备份恢复和知识资料关联。跨端验证必须在同数据、同时间、同筛选和同授权范围下检查 UI→MCP、MCP→UI、拒绝访问及授权撤销；名称和统计也不能泄露。

## 开源依赖决策与包体证据

先复用当前 AntDV 组件、theme/locale 与弹层适配。日历评估 FullCalendar Vue（Standard 与 Premium Timeline 授权分开），拖拽评估 VueDraggablePlus，事件/计时清理评估 VueUse，大列表仅必要时评估 TanStack Vue Virtual。按当前锁定版本查官方文档和官方仓库，先做最小验证，再记录许可证、维护、Vue/TS、版本、包体和减少的复杂度。候选不是安装清单。不得移除其他应用仍使用的 UI 库。路由懒加载与按需导入保留。

当前决定：新增并锁定 `@vueuse/core@15.0.0`，其余候选不引入。AntDV 4.2.6、Vue 3.5.44与VueUse及其运行依赖均为MIT；Node>=22、Vue peer ^3.5.0与仓库匹配。新增lock仅VueUse core/shared/metadata和web-bluetooth类型依赖，未升级其他应用依赖。已查官方资料与官方npm元数据：

| 候选 | 已核对 | 决策状态 |
| --- | --- | --- |
| [FullCalendar Vue](https://fullcalendar.io/docs/vue) / [许可](https://fullcalendar.io/pricing) | 评估v7.1.3，2026-10-16发布；Vue3、TS；Standard MIT，Timeline/资源视图Premium，另需Temporal peer | 不引入：仍须适配计划/截止、只读源、领域CAS、时区和自定义时间线；不能消除这些业务代码，且不能将Premium误当MIT |
| [VueUse](https://vueuse.org/guide/best-practice) / [useIntervalFn](https://vueuse.org/shared/useintervalfn/) | 锁定v15.0.0，2026-09-16发布；MIT、Vue peer ^3.5.0；原始包解压920917字节不是浏览器加载量 | 已采用useIntervalFn/useEventListener/useMediaQuery按需导入；专注取消手动resize监听及计时/可见性清理。真实KeepAlive停止轮询/返回重读用例在桌面和手机通过，已包含最终分组回归 |
| [VueDraggablePlus](https://vue-draggable-plus.pages.dev/en/) | 评估v0.6.1，2026-01-11发布；MIT、Vue2/3、TS、Sortable.js | 不引入：当前拖动主要是调用领域移动/安排命令，替换数组排序不会减少授权/CAS/冲突回滚与键盘替代操作 |
| [TanStack Vue Virtual](https://tanstack.com/virtual/latest/docs/framework/vue/vue-virtual) | 评估v3.13.50，2026-10-29发布；MIT，Vue^2.7或^3；依赖virtual-core3.19.9 | 不引入：历史初始50条、按需继续加载，累计在服务端；当前100条浏览器流程无大量DOM一次渲染，不为分页新增虚拟焦点/动态高度维护 |

小验证证据：[候选版本/许可/发布时间](verification/dependency-candidates.json)、[可重跑脚本](verification/dependency-spike.mjs)、[结果](verification/dependency-spike.json)。`node docs/design/to-doo/unified-ui-v2/verification/dependency-spike.mjs`以Vue外部依赖、ES2022、minify/gzip比较：同类原生生命周期示例543B/309B gzip，VueUse按需4323B/2088B gzip，增量1779B gzip。示例源码746B→676B；这是小范围接口成本，不能当作整个产品的压缩收益。实际产品的首次页面与总包体最终对比仍未完成；虚拟渲染不能代替后端分页或统计。

页面拆分实测（完整功能和VueUse已接入，前后仅页面加载方式及其反馈变化）：

| 口径 | 拆分前 | 拆分后 |
| --- | ---: | ---: |
| ToDooWorkspace主文件JS | 529,153 B | 172,393 B |
| To Doo静态依赖图JS | 2,305,706 B | 2,196,273 B |
| 该依赖图逐文件gzip合计 | 738,358 B | 713,939 B |
| 宿主index静态依赖图JS | 611,452 B | 612,352 B |
| 宿主index逐文件gzip合计 | 203,682 B | 205,536 B |
| 全部应用JS合计 | 19,947,013 B | 19,960,008 B |
| 全部应用逐文件gzip合计 | 6,221,615 B | 6,239,149 B |

主文件减少356,760B（67.4%），静态图gzip减少24,419B；全部应用分文件gzip增加17,534B。按页拆分改变共享块及压缩边界，不能把主文件缩小当作全应用总包缩小。浏览器验证任务入口不请求Calendar/Rhythm/Review/Settings模块；遇到首次模块503可局部重试，保留任务草稿；功能未就绪时页头动作禁用。共享KeepAlive及已挂载表单不会因切换页面重新下载。

证据：[拆分前](verification/build-before-lazy.json)、[拆分后](verification/build-after-lazy.json)、[测量脚本](verification/measure-build.mjs)。重跑方式：先`npm run build`，再`node docs/design/to-doo/unified-ui-v2/verification/measure-build.mjs final`。这是JS静态图与逐文件gzip合计，不是额外下载量或浏览器缓存命中率；最终代码完成后仍须更新最终构建记录。

### 最终构建记录（2026-10-31）

最终实际构建通过，记录在[build-final.json](verification/build-final.json)。与上表紧邻懒加载之前版本相比：

| 口径 | 拆分前 | 当前最终 |
| --- | ---: | ---: |
| ToDooWorkspace主文件 | 529,153 B | 177,156 B |
| To Doo静态依赖JS | 2,305,706 B | 2,262,616 B |
| 静态依赖逐文件gzip | 738,358 B | 736,369 B |
| 所有应用JS | 19,947,013 B | 20,271,268 B |
| 所有应用逐文件gzip | 6,221,615 B | 6,341,048 B |

主文件减少351,997B（66.5%）；静态图gzip减少1,989B。最终还包括Ant Form禁用上下文、共享农历算法和新增业务，因此全应用JS/gzip增加，不能宣称全应用包体下降。农历只由懒加载Calendar/Rhythm引用；生命周期减少手动管理，但新增完整业务总行数并未减少。上述前后对比不具有剥离业务功能后的依赖因果关系；独立VueUse spike另提供该依赖的边际成本。

## 实施与证据日志（历史阶段状态，最终结果见末尾）

- 2026-10-30：完整读取目标文件、项目结构、现有修改、设计图册、核心查询及现有测试；确认当前已是隔离工作树，沿用现有分支和未提交内容。开始全套单测与类型检查基线。
- AppShell 阶段：`to-doo-unified-shell.spec.ts` 首先复现主菜单60px、目录208px、顶栏41px和跨页偏移，改为全局tokens后通过；`ToDooPageHeader` 统一标题，PageToolbar/SectionHeader 已在复盘使用。目录与详情分别位于全局顶栏下方。相关单测42项通过。
- 浏览器：`npm run test:e2e -- tests/e2e/to-doo-unified-shell.spec.ts tests/e2e/to-doo-light-sidebar.spec.ts tests/e2e/to-doo-loading.spec.ts tests/e2e/to-doo-mobile-lists.spec.ts`：桌面14项、手机14项通过。包含6个宽度、真实AntDV深浅色、420px详情、安全区/底部菜单、失败草稿、刷新焦点及冷加载返回。截图在 `test-results/{desktop,mobile}/to-doo-unified-shell-*/`；这些是阶段证据，尚非最终全图册验收。
- 统计阶段：回归复现同数据页面42分钟/MCP121分钟。新增核心 `statistics.ts` 统一带 canRead 的聚合；MCP 调用 `service.statistics`，适配层不再计算时长。跨日、DST、修正、运行、暂停、中断、休息、取消、资源撤销均已覆盖。相关领域4文件46项通过；MCP相关5文件24项通过。
- 复盘趋势使用全量 `completedByDay` 稀疏聚合，超过31天按连续日期桶汇总完整区间；与明细分页分开。目标仅展示目标清单，累计进度与所选复盘区间分开。90天末端完成项的组件回归先失败后通过。
- 专注核心阶段：新增 focusTopic、会话的 topicId/topicName/taskTitle 兼容字段、`service.focusHistory`、`GET /api/to-doo/focus/history`；历史使用开始时间+ID游标，活动会话独立获取，今日/累计/主题统计在分页前计算。1205条历史、插入后续页、归档/改名/重启、分批恢复和复制导入、HTTP身份/参数边界已验证。只补写备注清空快照名称的缺陷已由失败回归修复。
- MCP 专注：`query_to_doos(kind=focusSession,sort=recent,topicId?,from?,to?)`；`kind=focusOverview` 需focus+statistics权限，返回独立活动及完整今日/累计统计；focusTopic 使用既有实体发现/读写工具。游标绑定数据集、查询和实时授权身份。新增实体进入存储、授权映射、Schema、导入导出和复制关联映射。MCP相关10文件31项通过；专注核心/恢复6项通过。专注新UI已联通服务端，仍在补全最终验收。
- 类型检查在专注模型变更前通过；新模型带来的两个测试fixture缺少focusTopics已补全，第二次类型检查通过。阶段构建 `npm run build` 通过，有现有第三方 use-client 警告；最终构建仍需在全部功能完成后重跑。
- 早期全仓回归：379文件通过、1文件跳过；2723项通过、1项跳过。该轮在实施开始时启动、期间代码仍有修改，不能替代最终固定版本的全仓验证。
- 验证过程中的两项手机清单用例最初因旧测试硬编码4179 Origin、执行使用4289端口而被CSRF拒绝；沿用默认隔离端口重跑后通过，未放宽产品安全检查或测试断言。
- 专注新UI：`ToDooFocus.vue` 替换旧圆环页面；项目、概览、历史与底部计时条共用服务端状态，主题编辑复用现有实体表单。手机合并宿主/应用重复顶栏，并将模式/时长/任务/备注收进计时设置抽屉；手机项目/历史切换正在回归。计时字段单独为 `ToDooFocusTimerFields.vue`，旧focus grid/ring CSS已删除。
- 新浏览器回归包含真实创建/关联/暂停/刷新/结束/修正/归档，1205条旧记录下的近期历史/稳定继续载入/独立活动，另一个窗口结束后保留本窗口备注，以及读取503、写入503后的保存重试。之前整体阶段24项桌面/手机浏览器回归通过；最新手机分区调整后仍须以当前轮结果确认，不借用旧轮通过覆盖新布局。
- 快速暂停→恢复→结束复现旧revision提交，新增focusBusy覆盖“命令+重新读取”整个周期，原有桌面/手机流程回归已通过。
- 活动会话600个segments的MCP概览会明确返回 `truncatedFields: [active.segments]`，完整累计不受结构化显示截断影响；有失败→通过回归。
- 当前阶段整组领域/MCP测试47文件415项通过，构建通过；此后又增加合法自定义ID与暂停开放片段的回归，最新汇总待本轮完成后补记。类型检查此前通过，最终仍须重跑。
- 测试维护说明：Ant Segmented 的原生radio在视觉上隐藏，手机分区测试应点击用户可见的label并断言checked，不强制点击。1205条数据的隔离批量导入允许60秒，交互操作10秒；这是测试数据准备的边界，未删除或降低业务断言。
- 剩余：其他页面/六面板整理、完整视觉图册、依赖正式评估与包体对比、最终全套回归及整体审阅。没有当轮证据不标通过。

### 验收收尾顺序（历史记录，已完成）

以下验收工作均已完成，结果见末尾。早期日志中的“待实现/后续”仅描述当时状态，当前能力以覆盖表和最终证据为准：

1. 当前代码全仓单测、类型检查、构建及包体最终记录。
2. 桌面/手机全部To Doo与宿主相关浏览器流程，补UI→SDK/MCP→UI、资源拒绝/授权撤销。
3. 所有实现/测试修改冻结后重建169场景原生图册及索引，防止旧截图冒充当前结果。
4. 独立整体审阅发现的中断恢复与活动备注冲突已修复，正在复测；最终审阅结论与遗留说明。
5. 整理固定证据、兼容/恢复/运行方式、真实设备推送人工步骤；不部署正式服务。

### 已确定的统计语义

- 完成/待办使用同一个未删除、未归档的叶子任务图，避免父子重复计数；日期区间以截止优先于安排日期，没有日期的待办不计入某个日期区间。
- 专注休息/取消不计入投入；暂停/中断保留已闭合片段，运行中只延伸当前开放片段。跨日按设置时区的真实边界裁切，包含DST。修正时长整体计入首片段的开始日；次数只计已结束的专注，按开始日归属。
- 专注主题归档不删除会话，也不改变任务状态；名称在会话开始时保存，日后重命名或只补写备注均不覆盖历史名称。
- 新UI的长期专注主题采用独立focusTopic，避免把专注归档变成任务清单归档。历史、活动和累计共用核心查询；页面不以工作集第一页推算全部记录。


## 最终验收清单（自动验收完成，人工状态单列）

- [x] 图册全部视图/六类面板/手机布局实现并可操作；图片未覆盖的既有能力仍可用。
- [x] 320/390/768/1024/1440/1873px，深浅色、固定时间/数据/字体/缩放，同尺寸跨页截图及预先声明的 CSS 像素容差通过。
- [x] 保存刷新/重启、取消、失败保留、幂等、版本冲突、连续操作、输入法/键盘/焦点/隐藏校验通过。
- [x] 专注主题/归档/1000+ 历史/独立活动/累计统计/跨日/修正和恢复通过。
- [x] 习惯规则历史、农历、时区/DST、只读日历、全区间趋势、导入导出与旧数据恢复通过。
- [x] HTTP/core/MCP 共用授权领域逻辑；schema/SDK/权限/撤销/分页/响应预算/幂等/跨端一致性通过，更新 MCP 覆盖矩阵。
- [x] 类型检查、构建、领域/MCP 单测、桌面/手机浏览器和其他应用回归通过。
- [x] 依赖许可证/版本/包体和复杂度前后对比、共享组件、运行方式、兼容/迁移/恢复、截图索引及遗留状态齐全。
- [x] 真实设备推送等需人工项目列明步骤、结果和待验证状态；不将模拟结果称为送达。

## 数据兼容与恢复原则

新增字段提供兼容默认值，已有 portable 实体必须能重建。新增实体进入集合映射、schema 发现、存储、导入导出和权限分类。归档只改变主题可见性；历史保存展示快照，关联实体改名/归档/移除后仍可阅读。任何真实迁移/删除/发布都先准备可审阅差异及恢复方案，本次仅使用隔离测试数据。

### 分阶段领域与界面记录（历史）

- 设置已按偏好/提醒与连接/数据与恢复/清单管理分组，所有表单保留挂载以保留草稿；偏好保存进入统一PageHeader。共享ToDooFormLayout使用AntDV Form提供禁用上下文，并负责原生提交、invalid转发和动作插槽；实体/成果/偏好保持各自的业务规则。设置校验复用领域schema，折叠错误会展开并聚焦字段。桌面表单浏览器8项、相关组件27项通过；手机和宿主回归待当轮验证。“默认视图”首次打开逻辑已补齐并有浏览器回归。
- 默认视图已接通无明确目标的应用卡片/快捷入口/冷启动；明确appSection、任务等深链接和当前会话记忆优先。轻量私有GET `/api/to-doo/settings`读取同一settings实体，避免为路由偏好加载全库统计。路由/宿主21项单测与类型检查通过；默认视图、明确链接和返回记忆的桌面/手机新用例通过。整组桌面/手机各13项通过、1项旧成果恢复用例因新增分类未切到“数据与恢复”失败；已更新为点击实际“查看进度”入口，保留恢复正文和关联断言，待重跑。
- 专注备注新增真实请求延迟与双窗口有正文的失败回归，复现后修复：结束回执只清理所提交版本；新补写继续保留，可二次保存。首次编辑记录原始正文，保存保留稿前发现远端正文改变则展示两份内容，用户可保留两份或明确替换；提交仍使用CAS，再次改变须重新核对。空字符串清空备注也计入未保存状态。新增两项在桌面/手机均已通过；整组最终结果继续等待当轮结束。
- 习惯正在从默认周表改为“今天/历史”，计划保留完整历史数量弹窗与规则/跳过/撤销/暂停。新回归已证实habitEntry的from/to目前未在分页前生效，250条本日记录被混入200条旧记录；需按localDate过滤，并在显示达标前载入当前周期全部页，不能用不完整工作集推算。
- 设置/专注/旧完整业务流程合并回归桌面20项、手机20项通过（`/tmp/doo-know-settings-focus-browser.log`）；包含默认视图、折叠校验、草稿、原成果恢复、1205条专注、结束等待补写和双窗正文冲突。是当轮证据，不能代替后续固定版本全套。
- 习惯新增ToDooHabitCard，默认今天可直接输入数量，历史保留原周表和数量弹窗；按习惯时区展示当天，周/月累计单列。完整连续记录入口在操作菜单，逐页读取全部记录后复用habitStreak，读取期间版本变化会要求重读，历史规则估算及5000周期保护明确标注。日期过滤、资源撤销和相关规则/通知/schema/组件6文件63项通过，类型检查通过，浏览器仍在本轮验证。
- 浏览器同时发现原有跳过按钮一直提交amount=0但契约要求正数的真实缺陷。共享实体和命令契约改为非负数且“skipped或amount>0”联合约束；UI/HTTP/MCP/导入同源。旧的跳过记录保持兼容，普通0与负数拒绝，MCP重放不会生成第二条记录。新的浏览器流程保留真实跳过/撤销/暂停/刷新和450条分页数据断言。
- 最新习惯与原业务浏览器整组桌面7项、手机7项通过（`/tmp/doo-know-habit-current-browser.log`）：包含普通0校验、写503保留数量/同requestId重试、完整周期分页、跳过/撤销/暂停、连续451条历史、CSV导入导出及成果恢复。新增测试的两处类型声明已修正，当前类型检查已确认退出码0。
- 设置保存期间继续输入（包括改回保存前原值）曾被整体重置/快照watch误判为无草稿；现捕获提交版本，保存后仅合并后续编辑，并在该请求期间避免服务端刷新覆盖本地。两种延迟用例桌面2项、手机2项通过（`/tmp/doo-know-preference-drafts-current.log`）。

- 习惯、纪念日、复盘、通知的主要操作已进入统一PageHeader；复盘使用Ant Statistic与“趋势/累计目标/复盘记录”分区。农历原日期与下次公历分开，纪念日按30天内/更远/过去/待核对分层，空资料/提醒数不显示。
- 复盘明细的日期筛选在SQL分页前完成，MCP和HTTP同源；保存时 `save_entity(captureMetrics=true)` 根据最终from/to和可选清单重新统计。MCP自动捕获额外要求statistics权限，且接收实时授权scope；普通历史实体保存仍兼容。保存后刷新失败保留之前的真实区间快照，不能把库累计伪装为区间。
- 日历曾用“锚点前7天”读取月历，导致月初事件丢失；现由 `toDooCalendarRange` 统一显示和查询的42天/月、7天/周、28天/时间线范围。首次加载后根据数据集时区/每周起点校正，异步旧页面不能回写新页面请求；跨浏览器日界线有真实浏览器回归。
- 通知新增最近排序的键集游标、raisedOnly及reminderStates筛选；所有权工作区未读徽标独立于当前任务清单，MCP未读统计仍严格按授权范围计算。任务提醒的资源授权从真实taskId解析，habitEntry资源FK也已补全。
- read_reminders支持最多500个明确ID、requestId幂等和可选datasetId校验，只将已触发的未读改为已读；稍后、已处理、忽略、未来未触发记录保持原状态。UI先按稳定游标收集全部未读，再分批提交，非载入页循环伪称全部。
- `reminderSource`只提供导航上下文，与pending/complete权限和时机分开；HTTP为 `/api/to-doo/reminders/:id/source`，MCP为既有query的 `sourceContext=true` + 单个提醒ID，须额外拥有来源领域权限，可绑定expectedRevision。旧pending API对已处理提醒的拒绝不变。
- 通知单项动作复用现有ReminderController的幂等重试和忙碌状态，新增dismiss支持；稍后/忽略收进Ant Dropdown，六类状态由Tabs筛选。来源失效时snooze返回410，不留下不会送达的虚假承诺。
- 最新证据：复盘/外壳/AntDV浏览器桌面8、手机8通过；日历/外壳桌面5、手机5通过；通知历史+原到点提醒桌面7、手机7通过；通知相关单测4文件39项通过，MCP协议及相关接口13文件69项曾通过，后续新变更仍需最终重跑。
- 以上为阶段日志；这些实现及第一版截图均已完成，剩余仅当前版本最终回归、图册刷新和审阅收尾。


### 2026-10-31 最终验收准备

- 统一颜色移到`to-doo-tokens.css`，页面、Ant弹窗和宿主使用同一蓝色强调色；深色标题区跟随页面背景，不再显示独立浅底条。专注项目名称左对齐。标题限制两行，完整名称仍可读取；共享标题顶点固定，避免手机操作高度使基线漂移。
- AntDV Form提供忙碌禁用上下文；保存期间字段不接受新值的编辑器使用同一规则，设置偏好允许继续输入并只合并提交之后的编辑。非法公历输入不会退回旧值后悄悄保存；折叠校验展开聚焦。农历使用原日期文本，不经过公历DatePicker归一化。
- 复用现有MIT `lunar-javascript@1.7.7`，将提醒与页面的农历算法收敛到共享纯函数。解决公历年初漏掉上一农历年腊月，以及合法农历2024-02-30被公历控件替换。闰月缺失的非skip旧枚举保持兼容，界面明确显示使用非闰同月；不存在的农历日期不猜测转换。
- 修复按清单授权的保存视图、计划和activity查询：所有列表及嵌套task/occurrence/timeBlock、expectedRevisions引用都须授权，在分页前过滤。专注listIds只筛选历史，不能替换canRead授权范围；空数组不能暴露其他清单的活动会话。
- 专注`nextBreak`按授权范围内已结束番茄次数推荐长短休息（不受日期/项目/分页过滤影响）；0分钟显示跳过，不创建虚假会话。用户仍手动选择休息，不自动改变任务状态；旧API省略break targetMinutes的语义保持不变。
- 独立审阅复现中断记录调用takeover失败、活动备注轮询后结束覆盖另一窗口文本。前者改resume；后者复用基线冲突确认，选择合并/替换时鲜读版本并CAS结束。已有等待回执时继续补写、503重试、结束后保留草稿的回归仍保留。
- 第一轮原生图册169项通过：156组跨页几何、26桌面截图、12编辑器截图、8手机截图。最新样式/功能修改后明确标记needs-refresh，只有最终重跑成功才标当前。固定业务时间2026-10-30T09:00Z，DPR=1，zh-CN/UTC、Chromium、实际字体环境（Inter/Noto CSS，机器中文回退WenQuanYi；未擅自安装字体），逐帧记录源码指纹/数据集/字体与坐标。

## 运行、兼容与人工验收

- 开发：使用仓库原有项目环境与`npm run dev`，不更换线上服务工作目录。自动浏览器用`npm run test:e2e -- <spec...>`；脚本分别为desktop/mobile创建临时owner、SQLite、资料和端口4179/4180。不要并行启动两个浏览器夹具。视觉使用`npm run test:e2e -- --config=playwright.to-doo-visual.config.ts --project=desktop`。
- 兼容：focusTopic进入现有schema/实体映射/portable导出、复制导入和完整checkpoint；新会话的topicId/topicName/taskTitle为兼容字段。旧会话仍可读；从未保存过的旧任务标题无法从历史恢复，显示“历史任务专注”，不伪造原名称。无真实数据迁移或删除。
- 恢复：先在数据与恢复中导出完整JSON；目标数据集先预览，再明确选择重复策略及是否完整checkpoint；分批操作可查状态、取消或恢复。恢复后核对清单/主题/会话片段/规则版本/附件及知识关联；如采用原数据集身份，既有资源授权可能需要重新选择。数据库正式备份仍按仓库backup/restore流程制作一致性副本，portable导出不能替代整个主机备份。
- 真实推送：**待人工验证，未宣称系统通知送达**。在已部署HTTPS的真实浏览器进入设置→提醒与连接，核对服务配置与设备状态；由用户授予通知权限并登记当前设备；用“测试”确认系统级通知；再建2分钟后的任务提醒，关闭/后台页面等待，核对送达时间、点击来源、已读/已处理/稍后/忽略行为；分别测试撤销浏览器权限和离线后恢复，确认失败反馈。记录浏览器/系统版本、时区、送达结果，不记录endpoint/密钥。当前隔离自动测试只验证订阅协议、状态机、权限和失败分支。
- 本次不部署、不推送分支、不提交混有已有工作的大批修改。最终可审阅结果保留在当前开发工作树。


### 最后浮层回归与增量验证

整组浏览器回归实际发现较早提醒摘要（reminder-missed）覆盖了设置折叠项、手机快速录入操作；trace记录了intercepts pointer events。原提醒栈z-index1050也高于Ant Modal1000。修复：To Doo内已有统一通知徽标，不再另显示重复的较早提醒浮条；在其他应用仍保留摘要；即时卡片和错误提示保持显示，提醒状态未改变。提醒栈降到90，位于编辑弹窗和抽屉下方。新增真实浏览器回归先失败，再验证未读保留/徽标/跨应用摘要/即时卡片/实际取消弹窗。

全仓单测385文件、2770项通过，1个文件/1项可选离线搜索安装测试因未配置DOOKNOW_SEARCH_ARTIFACT而跳过（上轮误记为原生回滚门禁，已更正）。该轮在最后两处提醒UI改动前完成；之后全部To Doo/MCP相关51文件450项、类型检查和构建再次通过。核心/HTTP/MCP源码未在这两轮之间改变；不把前一轮的源码指纹冒充最终指纹。完整日志保存在verification/logs。

独立审阅补查了这两处提醒改动，未发现未解决Important/Critical，未修改源码或启动夹具。最终浏览器分成互不重叠两组：reminders/unified-shell/ux的21项/项目，以及其余96项/项目；长批次中的失败与未执行项再由13项/项目独立补跑关闭。最终169项图册已通过。首轮完整失败记录保留，不以删除用例或降低断言制造通过。旧60px断言改为规范要求的64px，习惯数量弹窗测试从新的“历史”入口进入，原有取消/持久化/数量断言保留。


## 首轮UI统一验证结果（历史，最新结果见补查）

| 检查 | 结果与证据 |
| --- | --- |
| 全仓Vitest | 385文件/2770项通过，可选离线搜索安装测试1文件/1项跳过（上轮误记为回滚门禁，现已更正）；[日志](verification/logs/full-unit.log)。在最后两处纯提醒UI改动前执行，源码指纹单独保留。 |
| 最后UI改动后领域/MCP/组件复测 | 51文件450项通过；[日志](verification/logs/final-affected.log)。共享核心及HTTP/MCP在两轮间未改动。 |
| 类型检查 / 构建 | 最新代码均退出0；[类型](verification/logs/final-types.log)、[构建](verification/logs/final-build.log)、[最终包体](verification/build-final.json)。构建有既有第三方use-client提示，未吞掉类型或构建错误。 |
| 桌面/手机功能与宿主 | **234个预期用例逐项核对，232通过、2设备条件跳过，未验证项0**；[逐项证据](verification/browser-coverage.json)。不是把某个长批次的退出状态写成全绿。 |
| 独立审阅 | 三项实际问题（中断继续、跨窗备注覆盖、提醒遮挡）已关闭；[独立记录](verification/INDEPENDENT-REVIEW.md)。无未解决Critical/Important代码问题。 |
| 原生视觉 | 最终169项全部通过（5.3分钟）；156组跨页几何、26桌面/12编辑器/8手机截图。[图册](verification/current-ui/index.html)、[逐帧来源/环境/坐标](verification/current-ui/index.json)、[日志](verification/logs/final-visual.log)。 |
| 真机系统推送 | 待人工，具体步骤见上文；未宣称已送达。 |

浏览器按实际结果合并：提醒/外壳/快速录入21项每项目通过；其余96项的长批次中有一次桌面初始化超时及一次手机复盘数据污染，随后用独立夹具补跑复盘、任务行、导航和完整业务13项每项目全部通过。复盘回归已在补查中改为真实区间精确基准（允许非0），并验证小于全库累计；刷新失败仍保持原区间和精确指标；未通过时间放宽或删除步骤制造成功。所有用例的最后一次结果、历史失败及日志行号均在browser-coverage.json中；2项设备条件跳过分别是桌面运行的触摸大屏、手机运行的桌面目录拖动，其对应设备流程正常通过。

保留的测试环境限制：长批次开发服务器偶发初始化超过默认5秒断言，独立夹具严格断言补跑通过；未将其宣称为已定位修复的产品性能问题，也未承诺冷启动性能SLA。建议把网络故障注入、数据量和普通业务流程分组运行；不并发启动共享.local配置的浏览器夹具。[初轮失败日志](verification/logs/browser-initial-failures.log)和最终分组日志一并保留。

分组重跑：

```bash
npm run test:e2e -- tests/e2e/to-doo-reminders.spec.ts tests/e2e/to-doo-unified-shell.spec.ts tests/e2e/to-doo-ux.spec.ts
npm run test:e2e -- tests/e2e/to-doo tests/e2e/app-main-menu.spec.ts tests/e2e/app-shortcuts.spec.ts tests/e2e/responsive-tabbar.spec.ts tests/e2e/responsive-layout.spec.ts tests/e2e/notes-first.spec.ts tests/e2e/blog.spec.ts --grep-invert 'to-doo-(reminders|unified-shell|ux)\.spec\.ts' --max-failures=1
npm run test:e2e -- tests/e2e/to-doo-review-period.spec.ts tests/e2e/to-doo-task-row-clarity.spec.ts tests/e2e/to-doo-visible-workspace.spec.ts tests/e2e/to-doo.spec.ts --max-failures=1
```

逐项核对使用`verification/consolidate-browser.mjs`，接收`playwright --list`输出与按时间排列的日志；每个预期用例必须有最后一次passed或原有设备条件skipped，未执行/失败不能算通过。需要复跑后生成本机新证据，不能直接复制本轮通过数。


### 首轮自动验收关闭（历史）

最终图册status=passed，源码（含测试）1093文件SHA-256 `04a1ea1e4a930e3996910455805e8641a0a39a4e95a60bf4ae8ba956f96f36ec` 与当前一致；生产源码单独指纹 `2b596dff23e3f9cf3b4a06c516d492fd2fc115a36d46ea870b7400de6983b93a` 自最后构建后未变。已目视核对任务/详情浅色、专注深色、手机习惯深色、时间安排表单，未编辑截图或用生成图替代实际页面。

自动功能与视觉验收全部有逐项证据；没有未关闭的Critical/Important实现问题。保留事项仅为上文列明的真实设备推送人工验收、可选离线搜索安装验证（回滚安装包实际存在，补查15项回滚测试已通过），以及长批次开发环境初始化超时观察（严格隔离复测通过，未承诺性能SLA）。当前工作树保留可审阅修改，不部署、不推送、不修改真实用户记录。


2026-10-31补查：原生回滚15项通过；此前“缺少发行包”判断已更正。加载超时继续定位，真机推送等待设备信息，见[补查记录](FOLLOWUP-2026-10-31.md)。


2026-10-31性能补修：提醒调度逐条全量快照导致的周期性阻塞已修；原96项桌面组连续95通过/1设备条件跳过，手机118项117通过/1设备条件跳过。新增缓存与安全边界7项通过，完整相关52文件457项通过，类型与构建通过；当前总234项浏览器用例通过，详最新补查验收。真实系统通知送达仍等待用户设备信息，未发布线上MCP或应用服务。


补查最终结果：加载超时根因修复后的原长批次与手机整批连续通过；当前234项浏览器用例通过、2项设备条件跳过，52文件457项相关测试及类型/构建通过，缓存7项边界与原生回滚15项通过。最新169项视觉检查通过，46张原生截图已刷新、源码指纹一致。仅真实系统通知送达仍待用户设备确认，详[最新补查验收](verification/followup-acceptance.json)。
