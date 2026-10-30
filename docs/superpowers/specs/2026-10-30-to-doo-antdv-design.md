# To Doo Ant Design Vue 控件迁移

用户要求在 To Doo 更多位置合理使用已经安装的 AntDV，而非仅在导航上使用。沿用已确认的品牌、两级菜单和按需目录，保留全部业务数据与草稿合同。

## 设计

- 主流操作按钮使用 AntDV Button，保留 htmlType=submit/reset 与键盘表单行为；纯自定义绘图和拖动区域保持其语义。
- 文本/长文本/数字/勾选使用 Input、Input.TextArea、InputNumber、Checkbox/CheckboxGroup；合理使用 Segmented、Select、Modal、Dropdown、Collapse、Alert、Empty、Statistic、Progress。
- 日期与时间通过 `ToDooDateField.vue` 使用 DatePicker/TimePicker，继续以本地 YYYY-MM-DD、HH:mm 或 datetime-local 字符串传递，不引入 UTC 漂移。
- `ToDooSelect.vue` 使用 Select，并把原 option/optgroup 或 options 转成标准 AntDV 选项。内部键与业务值分离，保留 null、boolean、number、字符串和多选数组，避免空值/布尔语义改变。
- 原生浏览器确认改为宿主提供的 AntDV Modal 确认；实体、批量、成果等表单使用 Modal，任务详情继续保留适合宽屏/手机的布局。
- 弹层可访问名称、焦点恢复、Esc/取消、异步 loading/disabled 与错误反馈保留；作用域样式仅覆盖 To Doo。

## 共享控件接口

`ToDooSelect`：支持 `v-model`（modelValue）或受控 value，`multiple`、disabled、placeholder、options；默认 slot 可保留 option/optgroup。change 直接返回真实业务值或多选数组（不返回 DOM event），同时 emit update:modelValue/update:value。

`ToDooDateField`：支持 v-model 或受控 value，type=date/time/datetime-local、disabled、required、allowClear、min/max。清空返回空字符串；change/input 返回字符串，同时 emit update:modelValue/update:value。普通文本与数字控件直接按需导入 AntDV。

`useToDooConfirm()`：返回异步 `(content:string, options?:{title?:string;danger?:boolean}) => Promise<boolean>`。由 ToDooWorkspace 提供，确认与取消通过 AntDV Modal 完成；无宿主时拒绝执行需要确认的动作。

## 约束与验收

不添加依赖，不修改服务端/实体格式、不写真实任务或重置账号、不发布正式服务。保留已有未提交工作。仅界面改动无需镜像测试；需要验证日期、类型化选择与多选、取消不写入、保存/导入真实回执、键盘及窄屏。浏览器夹具顺序运行，不能与使用同一端口的全项目生命周期测试并发。
