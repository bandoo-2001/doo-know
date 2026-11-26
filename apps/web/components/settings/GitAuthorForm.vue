<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { Alert as AAlert, Button as AButton, Input as AInput } from 'ant-design-vue';
import { gitAuthorIssue } from '../../../../shared/git-author';
import { features, refreshFeatures, saveFeatureConfig } from '../../features';
import {
  gitAuthorDraft,
  hasUnsavedGitSettings,
  loadGitAuthorDraft,
} from '../../git/settings-draft';
import { gitError } from '../../git-sync';
import { ApiError } from '../../api';

const props = defineProps<{ forCommit?: boolean }>();
const emit = defineEmits<{ saved: [] }>();
const id = useId();
const git = computed(() => features.value.git);
const missing = computed(
  () => !!gitAuthorIssue(git.value?.config.authorName, git.value?.config.authorEmail),
);
const busy = ref(false),
  error = ref(''),
  notice = ref('');
const invalid = ref<'name' | 'email'>();
const stale = computed(
  () =>
    !!git.value &&
    !!gitAuthorDraft.value &&
    git.value.configVersion !== gitAuthorDraft.value.version,
);
let active = true;
onBeforeUnmount(() => {
  active = false;
});
watch(
  git,
  (feature) => {
    if (feature) loadGitAuthorDraft(feature);
  },
  { immediate: true },
);
function reload() {
  if (git.value) loadGitAuthorDraft(git.value, true);
  error.value = notice.value = '';
  invalid.value = undefined;
}
async function save() {
  const draft = gitAuthorDraft.value;
  if (!draft || busy.value || stale.value) return;
  const name = draft.authorName.trim(),
    email = draft.authorEmail.trim();
  invalid.value = props.forCommit || name || email ? gitAuthorIssue(name, email) : undefined;
  error.value = notice.value = '';
  if (invalid.value) {
    await nextTick();
    document.getElementById(id + '-' + invalid.value)?.focus();
    return;
  }
  busy.value = true;
  try {
    const saved = await saveFeatureConfig(
      'git',
      { authorName: name, authorEmail: email },
      draft.version,
    );
    if (!active) {
      // Saving a missing signature can dismiss this inline form as soon as the feature updates.
      if (
        props.forCommit &&
        features.value.git === saved &&
        gitAuthorDraft.value === draft &&
        draft.authorName.trim() === name &&
        draft.authorEmail.trim() === email
      )
        loadGitAuthorDraft(saved, true);
      return;
    }
    loadGitAuthorDraft(saved, true);
    notice.value = '提交署名已保存。';
    emit('saved');
  } catch (failure) {
    if (!active) return;
    error.value = gitError(failure);
    if (failure instanceof ApiError && failure.data.code === 'CONFIG_VERSION_CONFLICT')
      await refreshFeatures().catch(() => {});
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <form
    v-if="gitAuthorDraft"
    class="git-author-form"
    aria-label="提交署名"
    novalidate
    @submit.prevent="save"
    @input="
      invalid = undefined;
      notice = '';
    "
  >
    <p v-if="forCommit && missing" class="git-author-hint">
      首次提交需要署名。填写后即可继续，提交说明会保留。
    </p>
    <div class="git-author-fields">
      <label :for="id + '-name'"
        >提交作者
        <AInput
          :id="id + '-name'"
          v-model:value="gitAuthorDraft.authorName"
          :disabled="busy"
          :maxlength="100"
          placeholder="显示在提交记录中的姓名"
          :aria-invalid="invalid === 'name'"
          :aria-describedby="invalid === 'name' ? id + '-issue' : undefined"
          :status="invalid === 'name' ? 'error' : undefined"
        />
      </label>
      <label :for="id + '-email'"
        >作者邮箱
        <AInput
          :id="id + '-email'"
          v-model:value="gitAuthorDraft.authorEmail"
          :disabled="busy"
          :maxlength="254"
          type="email"
          placeholder="name@example.com"
          :aria-invalid="invalid === 'email'"
          :aria-describedby="invalid === 'email' ? id + '-issue' : undefined"
          :status="invalid === 'email' ? 'error' : undefined"
        />
      </label>
      <AButton
        html-type="submit"
        :loading="busy"
        :disabled="stale || (!forCommit && !hasUnsavedGitSettings())"
        >保存提交署名</AButton
      >
    </div>
    <p v-if="invalid" :id="id + '-issue'" role="alert" class="git-author-error">
      {{
        invalid === 'name'
          ? '请填写提交作者，姓名不能包含尖括号或控制字符。'
          : '请填写有效邮箱，例如 name@example.com。'
      }}
    </p>
    <AAlert v-if="error" type="error" show-icon :message="error" />
    <AAlert v-if="stale" type="warning" message="提交署名已在其他位置更新。"
      ><template #action
        ><AButton size="small" @click="reload">载入已保存设置</AButton></template
      ></AAlert
    >
    <p v-if="notice" role="status">{{ notice }}</p>
  </form>
</template>
<style scoped>
.git-author-form {
  display: grid;
  gap: 10px;
}
.git-author-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.git-author-fields label {
  display: grid;
  gap: 6px;
  flex: 1 1 180px;
  min-width: 0;
}
.git-author-hint {
  color: var(--muted);
}
.git-author-error {
  color: var(--danger, #b42318);
}
</style>
