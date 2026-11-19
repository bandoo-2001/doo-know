# MCP 2.0.4 与宿主 API 1.5 兼容性

这里的宿主 API 是 DooKnow 内部插件接口，和 MCP 线上的 `2025-11-25` 协议版本不同。本次不升级 MCP SDK 大版本，也不迁移数据库。

## 实际发现

只读核对原 rc68 的已编译代码后，确认其 `HOST_PLUGIN_API` 为 1.4.0，但具备以下限制：

- ToDoo 工具表没有开始上传、完成上传、读取纪念日图片三个新工具；实际 host 调用入口会拒绝未知工具。
- 严格的旧筛选 schema 不认识 `filter.taskScope`。
- 旧清单字段 schema 没有 `parentId` 和自定义 `icon`。

此前 MCP 2.0.3 的 `apiVersion: ^1.4.0` 仍允许这个旧宿主安装，因此存在“允许安装，但新工具或参数无法使用”的实际兼容缺口。不能用新宿主的测试通过证明所有 1.4 宿主都支持这些能力。

## 最小修正

- 当前宿主 API 提升到 **1.5.0**，标识扩展后的 ToDoo 服务契约。
- 新 MCP 插件提升到 **2.0.4**，要求 **`^1.5.0`**。使用新补丁号，避免已构建或已安装 2.0.3 的相同版本缓存混淆。
- Git 1.1.4 的实际约束 **`^1.0.0`** 原样保留，仍允许宿主 1.5；旧 MCP 的 `^1.4.0` caret 约束也允许新宿主，既有方法保持可用。

没有通过放宽旧宿主校验、忽略未知字段或吞掉工具错误来伪造兼容。

## 已完成的验证

1. 在 OS 临时目录创建独立数据库、知识库和插件目录，只导入 rc68 已编译的 `openDatabase`、`pluginHost` 与 API 常量，给它安装真实新 MCP 2.0.4 artifact。安装阶段以 400 / `INVALID_PLUGIN_MANIFEST` 拒绝；没有已安装 MCP 记录，也没有激活贡献。临时数据随后删除。没有连接、停止或写入 5173 主实例。
2. 新宿主 API 1.5 的真实打包 HTTP 测试覆盖标准 SDK v1、v2 legacy、v2 auto 与 OAuth/API Key 六个组合，执行 ToDoo 业务闭环。
3. 相关宿主、插件与 MCP 回归共 **6 文件、30 测试通过**；新增 caret 兼容矩阵测试明确检查旧 1.4 拒绝新 MCP、新宿主接受新 MCP，并保留 Git `^1.0.0` 与旧插件 `^1.4.0` 的兼容性。

构建产物和原始结果位于 `.local/production-readiness/host15-plugins/`、`host15-plugin-regressions.log`；旧宿主安装拒绝的实际记录位于原始工作区 `.local/production-readiness/legacy-host-mcp204-install-rejection.json`。

上述是源码和实际插件包验证。正式原生安装仍须由发布流程从干净提交重建，并从 catalog 更新到 MCP 2.0.4 后检查实际 serverInfo 与工具 schema。此前 `.2` / `.3` 安装中的 MCP 2.0.2 / 2.0.3 结果保留为相应版本的基线，不能改写为 2.0.4 原生成功。
