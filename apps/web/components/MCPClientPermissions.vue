<script setup lang="ts">
import { ref } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import type { PermissionPolicy } from '../../../shared/permissions';
import type { MCPConnectionState } from '../../../shared/mcp-connection-contracts';
import MCPDomainPermissions from './MCPDomainPermissions.vue';
import { api } from '../api';
import { describePermissionPolicy } from '../mcp-permissions';
const props=defineProps<{client:MCPConnectionState['clients'][number]}>();
const emit=defineEmits<{updated:[]}>();
const draft=ref<PermissionPolicy>(),busy=ref(false),error=ref(''),notice=ref('');
function edit(){
  const policy=props.client.effectivePolicy || props.client.permissionPolicy;
  if(policy)draft.value=JSON.parse(JSON.stringify(policy));
  error.value='';notice.value='';
}
async function save(){
  if(busy.value || !draft.value)return;
  busy.value=true;error.value='';
  try{await api('/api/platform/mcp/clients/narrow','POST',{clientId:props.client.clientId,permissionPolicy:draft.value,expectedGrantVersion:props.client.grantVersion});draft.value=undefined;notice.value='已收窄连接权限；原令牌已失效，请在客户端重新授权。';emit('updated');}
  catch{error.value='未能确认权限更新，请刷新连接状态后核对。';}
  finally{busy.value=false;}
}
</script>
<template>
  <div class="client-permissions">
    <p v-if="client.permissionPolicy">已授予：{{describePermissionPolicy(client.permissionPolicy)}}</p>
    <p v-if="client.effectivePolicy">当前生效：{{describePermissionPolicy(client.effectivePolicy)}}</p>
    <AButton v-if="client.active && client.effectivePolicy && !draft" size="small" @click="edit">收窄连接权限</AButton>
    <template v-if="draft">
      <MCPDomainPermissions v-model="draft" :ceiling="client.effectivePolicy || client.permissionPolicy" :disabled="busy" consent />
      <p>保存后立即收窄权限并使原令牌失效；扩大权限需重新发起客户端授权。</p>
      <AButton size="small" :loading="busy" @click="save">保存收窄权限</AButton>
      <AButton size="small" :disabled="busy" @click="draft=undefined">取消</AButton>
    </template>
    <AAlert v-if="error" type="warning" :message="error" />
    <p v-if="notice" role="status">{{notice}}</p>
  </div>
</template>
<style scoped>.client-permissions{width:100%;min-width:0}.client-permissions p{font-size:12px;line-height:1.7;overflow-wrap:anywhere}.client-permissions :deep(.ant-btn){margin-right:8px}</style>
