<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import { api } from '../../api';
import type {
  ManagementOverview,
  ManagementDiagnostics,
} from '../../../../shared/management-contracts';
import { downloadBlob } from './download';
const environments: Record<string, string> = {
  development: '开发环境',
  production: '正式环境',
  test: '测试环境',
  unspecified: '未标注',
};
const state = ref<ManagementOverview>(),
  error = ref(''),
  busy = ref(false),
  diagnosticBusy = ref(false),
  diagnosticError = ref(''),
  notice = ref('');
async function load() {
  busy.value = true;
  error.value = '';
  try {
    state.value = await api<ManagementOverview>('/api/manage/overview');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function diagnostics() {
  diagnosticBusy.value = true;
  diagnosticError.value = '';
  notice.value = '';
  try {
    const data = await api<ManagementDiagnostics>('/api/manage/diagnostics');
    downloadBlob(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      'dooknow-diagnostics.json',
    );
    notice.value = '已下载脱敏诊断。';
  } catch (e) {
    diagnosticError.value = (e as Error).message;
  } finally {
    diagnosticBusy.value = false;
  }
}
onMounted(() => void load());
</script>
<template>
  <div class="settings-stack">
    <section class="settings-card">
      <div class="settings-item-header">
        <div>
          <h2>DooKnow</h2>
          <p>让原文成为可以持续使用的知识。</p>
        </div>
        <AButton size="small" :loading="busy" @click="load">刷新信息</AButton>
      </div>
      <AAlert v-if="error" type="error" :message="error" />
      <p v-if="busy && !state" role="status">正在读取应用信息…</p>
      <template v-if="state"
        ><p>服务版本 {{ state.release.version }}</p>
        <p class="settings-muted">
          运行环境：{{ environments[state.release.environment] || state.release.environment }}
        </p>
        <p class="settings-muted">
          知识库{{ state.library.ready ? '可用' : '尚未就绪' }} · 共享{{
            state.capabilities.shares ? '可用' : '尚未就绪'
          }}
          · 回收站{{ state.capabilities.trash ? '可用' : '尚未就绪' }} · 设备管理可用
        </p></template
      >
    </section>
    <section class="settings-card">
      <h2>使用帮助</h2>
      <ul class="settings-muted">
        <li>笔记采用手动保存，按 <kbd>Ctrl / ⌘ + S</kbd> 保存内容。</li>
        <li>在左侧目录选择笔记，使用顶部搜索查找内容。</li>
        <li>新建按钮和目录菜单中可以导入资料。</li>
        <li>回收站可以找回归档的笔记；永久删除前请确认范围。</li>
        <li>左下角「状态」显示检索、写入和后台任务进度。</li>
        <li>弹窗打开时按 <kbd>Esc</kbd> 关闭允许关闭的弹窗。</li>
      </ul>
    </section>
    <section class="settings-card">
      <h2>更新与回退</h2>
      <p class="settings-muted">
        更新由部署者在运行 DooKnow 的主机上操作。这里显示的服务版本可用于更新后核对。
      </p>
      <details class="settings-muted">
        <summary>查看操作顺序</summary>
        <ol>
          <li>先保存笔记和插件配置，再确认备份与恢复密钥可用。</li>
          <li>
            正式安装使用主机终端运行
            <code>dooknow update</code
            >。更新器会检查版本、准备候选并制作备份；不要关闭正在进行的更新。
          </li>
          <li>
            完成后刷新本页，核对服务版本，再打开一篇笔记检查功能。开发环境请由维护者更新源码并重新启动。
          </li>
          <li>
            候选启动失败会尝试恢复旧代码；需要人工回退时使用
            <code>dooknow rollback</code
            >。数据不兼容时，应在独立目录恢复备份，不能覆盖正在使用的资料。
          </li>
        </ol>
        <a
          href="https://github.com/bandoo-2001/doo-know#日常管理"
          target="_blank"
          rel="noopener noreferrer"
          >查看安装、更新与恢复说明</a
        >
      </details>
    </section>
    <section class="settings-card">
      <h2>诊断与支持</h2>
      <p class="settings-muted">
        下载当前版本、功能状态与数量统计，便于排查问题。诊断不包含笔记正文、密码、密钥或私有目录路径。
      </p>
      <AAlert v-if="diagnosticError" type="error" :message="diagnosticError" />
      <div class="settings-actions">
        <AButton :loading="diagnosticBusy" @click="diagnostics">下载脱敏诊断</AButton
        ><span class="settings-success" role="status">{{ notice }}</span>
      </div>
    </section>
  </div>
</template>
