# 习惯与纪念日验收图

由 `tests/e2e/to-doo-life-audit.spec.ts` 通过真实、隔离的浏览器服务生成。浏览器时间固定为 `2026-11-03T12:00:00Z`，桌面 1440×900、手机 390×900；窄屏补充为 320×844。数据为测试创建的阅读数量、普通打卡、当天与过去的一次性纪念日、农历二月三十。浅色与深色使用相同状态。

| 问题 | 桌面 | 手机 |
| --- | --- | --- |
| H1：紧凑习惯卡、数量追加与普通打卡 | [浅色](desktop-habits-light.png) / [深色](desktop-habits-dark.png) | [浅色](mobile-habits-light.png) / [深色](mobile-habits-dark.png) |
| H2/H3：45/20 的真实累计量、三条记录与单条撤销入口 | [当天记录](desktop-habit-entries.png) | [当天记录](mobile-habit-entries.png) |
| A1/A2/A3：适中卡宽、就是今天、过去的原日期 | [浅色](desktop-anniversaries-light.png) / [深色](desktop-anniversaries-dark.png) | [浅色](mobile-anniversaries-light.png) / [深色](mobile-anniversaries-dark.png) |
| W5/W4：农历年/月/日、闰月校验与关闭说明 | [浅色](desktop-lunar-dialog-light.png) / [深色](desktop-lunar-dialog-dark.png) | [浅色](mobile-lunar-dialog-light.png) / [深色](mobile-lunar-dialog-dark.png) |
| A1：320px 卡片外边界与页面宽度 | [桌面项目缩窄](desktop-anniversary-320.png) | [手机项目缩窄](mobile-anniversary-320.png) |

农历窗口图保留前一次选择不存在闰月后的校验反馈；测试随后取消放弃提示、保存有效的 `2024-02-30` 并重新打开核对。数量记录图拍于撤销前，随后测试从三条中仅撤销 10 页一条，验证剩余两条为 15、20 页且累计变为 35 页。

320px 几何回归在现有 `minmax(min(100%, 260px), 340px)` 网格下已通过，因此没有为假设的溢出额外修改网格。截图证明浏览器视口表现，不能代替真实操作系统软键盘验收。原审计材料位于相邻 `../before/`；本目录为固定边界日期的功能验收图，不宣称与原审计不同日期、不同示例数据逐像素对比。
