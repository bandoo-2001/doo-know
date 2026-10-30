# To Doo 的 Ant Design Vue 控件

To Doo 使用项目现有 Ant Design Vue 4.2.6，与全局 ConfigProvider 共用语言和主题。普通表单与操作按需导入组件，保留应用自己的菜单、品牌和内容布局；不加载全局 reset，也不影响笔记编辑器样式。

## 控件约定

- 按钮使用 Button，提交按钮设置 `html-type="submit"`；`type` 仅表示 Ant 按钮样式。
- 文本、长文本、数字与勾选使用 Input、Textarea、InputNumber、Checkbox。数字清空按原字段含义归一成空字符串或 null，不能把 0 当成未填写。
- 视图、菜单、折叠、表单与确认使用 Segmented、Dropdown/Menu、Collapse、Modal；反馈使用 Alert、Empty、Statistic 和 Progress。
- 自定义日历事件/时间线命中区、习惯格、完成趋势和专注圆环保留其原有语义，文件输入保留浏览器 File API。

## 业务值适配

`components/to-doo/ToDooSelect.vue` 以 Ant Select 渲染，可使用原 option/optgroup slot 或 options 数组。v-model 继续传原业务值，支持 null、boolean、number、字符串与多选数组；内部选项键不写回业务数据。`change` 返回实际值，而非 DOM Event。搜索按可读标签，控件的可访问名称保持为字段名，排除选中项与图标。

`ToDooDateField.vue` 使用 DatePicker/TimePicker，支持 date、time 和 datetime-local。值为 YYYY-MM-DD、HH:mm 或本地日期时间字符串，日期不先转换 UTC。可选日期清空返回空字符串；required/min/max 与未确认输入的校验保持有效，错误使用 Ant 状态和可访问属性，Escape 可取消未确认输入。

`ToDooDisclosure.vue` 是单面板 Collapse，open 为初始及数据变化时的展开提示。菜单操作使用 Dropdown/Menu，避免把操作菜单当作详情折叠。

## 弹层与确认

表单 Modal 通过显式 open 状态控制；保留草稿的弹窗保持组件挂载。Modal 使用 Portal，不能用外层 `v-show` 控制开关。弹层样式限定在 `todo-ant-modal` / `todo-ant-popup`，样式适配在 `to-doo-ant.css`。

`to-doo-controls.ts` 的 `useToDooConfirm()` 返回异步确认，由 ToDooWorkspace 提供 Modal 宿主。取消或组件离开不会提交命令。异步确认前要捕获任务/执行实例/选择范围，确认后检查上下文仍有效，避免把动作应用到后来打开的任务。

共享日期与选择适配、确认服务有定向测试；实际控件操作使用 `tests/support/to-doo-ant-controls.ts` 和浏览器用例验证，测试不靠强制点击或修改页面模型。

## 加载与内容过渡

`ToDooLoadingState.vue` 使用 Ant Skeleton，按列表、卡片、四象限或日历显示低对比占位。首次数据读取使用 embedded 模式；异步组件下载超过 150ms 时显示带 To Doo 标识的同款占位。骨架缓慢呼吸，首次内容以 220ms 透明度动画出现，系统开启“减少动态效果”时关闭动画。

已有内容刷新时保持 KeepAlive、输入和焦点，顶部细条脱离文档流，延迟 140ms 淡入，不插入挤动正文的提示，也不延长请求。异步组件的 ref 可能暂时指向加载组件，离开检查须使用可选方法调用；加载中仍可返回，晚到的组件不能改变返回后的页面。首次读取失败沿用重新载入入口。相关慢网、失败、焦点与返回行为由 `tests/e2e/to-doo-loading.spec.ts` 验证。
