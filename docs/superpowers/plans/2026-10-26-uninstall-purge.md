# Uninstall Purge Implementation Plan

**Goal:** 增加可选资源清理，保留原文和可恢复备份。

**Architecture:** 独立清理模块负责只读规划及路径保护；CLI 在既有管理锁和服务归属检查内调用，普通卸载不变。

**Tech Stack:** TypeScript、Node fs、SQLite readonly、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-26-uninstall-purge-design.md`

## Global Constraints

- 不卸载真实服务；测试仅操作自有临时目录。
- 原文、备份、数据库、配置和密钥必须保留；外部服务不处理。
- 保留已有未提交验收记录。

## Review Focus

配置未记录原文路径但数据库已绑定；自定义目录包含原文或备份；符号链接祖先；清理前目标身份变化；清理失败不得输出成功。

## Tasks

- [x] 写 CLI 资源清理/普通卸载保留的回归并观察失败。
- [x] 增加清理模块及边界测试：默认/自定义目录、原文绑定、备份文件头、目录交叠和符号链接。
- [x] 接入 `--purge`、帮助与说明，验证服务归属检查和失败行为。
- [x] 运行相关测试及类型检查，独立审查最终变更并处理实质问题。

执行选择：在当前已隔离的 `txj/editor-improvements` 工作树内完成这一小项，不触碰既有验收记录，不发布、不执行实际卸载。

## Verification

新增及既有 CLI 回归最终共 28 项通过（19 项新增、9 项既有），独立审查的两项 Important 均有先失败再通过的回归；另外覆盖缓存中任意命名的 PEM 备份私钥保护。默认卸载及服务归属保护通过。

类型检查曾通过；最后一次检查受并行开发中的 `tests/blog-security.test.ts` 类型错误影响而退出2，无本次清理模块错误。完整 `npm test` 发现 `tests/blog.test.ts`、`tests/mcp-blog-authorization.test.ts`、`tests/mcp-blog-tools.test.ts` 失败；因工作区持续被其他任务修改，已停止本次全量运行（143），全部6个记录的自有进程已退出，不冒称全项目通过。细节保留在 `.local/uninstall-purge-*`。

未执行真实卸载，未发布，未提交或覆盖其他并行工作。当前能力在源码中，需随后续发行版安装后使用。
