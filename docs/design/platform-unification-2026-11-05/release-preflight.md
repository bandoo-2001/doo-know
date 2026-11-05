# 新版本打包预检（未执行新版本构建）

当前本地已知最新发行标签 `v1.1.0-rc.61`，兼容代次 6；主分支源码已包含后续 ToDoo 交付至 `933d63d`。新版本号只能在本轮全部实现与验证完成、再次核对远端标签/版本后确定，不在设计前占用或发布版本。

现有真实流程为 `scripts/release.mjs`、`scripts/verify-release.ts` 和 `scripts/release-verification.ts`，不是新的自制打包器。

## 原生包规则

- 当前发行脚本明确只支持 **Linux x86_64**；不能声称已有 Windows/macOS/ARM 原生发行流程。
- `node scripts/release.mjs --version <new-version> --output <artifact-directory> --base-url <controlled-source>`，脚本默认先生产构建。制品源只允许 HTTPS 或受控本机环回 URL，拒绝内嵌凭据与查询参数。
- 发行包含 dist、bin、包/锁清单、Node 22.22.1、当前格式运行时文件、生产依赖、MCP/Git 插件、独立检索包清单、安装器及 notices；运行时/主包都核对 SHA-256。
- 主包、release 元数据、release.txt、安装器、插件归档/目录、独立搜索归档及摘要由原流程生成。`release.json` 记录源码提交、dirty 状态及兼容代次 6。
- `.local/release-inputs` 的固定 Node 包及 `.local/platform-execution/search-artifacts/search-runtime.json` 是既有输入。已只读流式核对原项目中31,060,640字节Node归档与492,511,323字节检索归档：均与发行脚本锁定值/已有检索元数据SHA256一致，后者长度亦匹配；见[输入校验记录](./release-inputs-verification.json)。未读取凭据、解包安装、拷贝用户数据或重造检索包。这只验证已有输入，不代表新主包或可执行门禁已完成。

## 可执行验证要求

- `npm run verify:release -- --directory <artifacts> --output <evidence-outside-artifacts> ...`，必须是当前已提交且干净源码构建的制品，sourceCommit 对齐，dirty=false。
- 当前格式需要另一个**同提交/同代次、不同版本名**的原生包用于恢复路径验证，以及固定大小/摘要的已发行 rc.48 旧包用于跨代次拒绝验证；不能拿任意历史包代替。
- 原项目已有rc.48主包已只读核对：228,478,191字节，SHA256与`verify-release.ts`固定值一致；同见输入校验记录。目前3个既有输入均已验证，不需因旧包缺失停工；同提交的新版恢复制品仍须在本轮代码完成后新建。
- 门禁检查 `typecheck`、`platform-tests`、`artifact-install-smoke`、`browser-regressions`，回执绑定制品文件散列与源码；早期/失败/过期回执不得复用为最后成功证据。
- 执行验证要限定新工作区、临时知识库/数据库/安装根和受控本机制品源，不能使用生产 profile 或接管既有 `doo-know.service`。后续实际执行前仍须逐条核对脚本命令与环境。
- 用户授权生成新版本和本机隔离可执行验证；没有授权向外部正式环境部署或公开 Release。不能调用发布/上传步骤，不能擅自推送发行标签或切换正式服务。

当前阶段：390/390 设计资产及独立全局审查已通过，平台实现源码已冻结到 `12b7798`，集中验证与运行证据仍在进行。此处仍无本轮新发行结果：**新版本主包、恢复验证包、摘要清单和执行门禁回执均尚未交付**。不能以设计通过或已有输入校验代替新包的可执行门禁；最新状态见[实现记录](./IMPLEMENTATION.md)。
