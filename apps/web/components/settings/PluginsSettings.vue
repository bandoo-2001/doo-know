<script setup lang="ts">
import PluginManager from '../PluginManager.vue';
import MCPAuthorizationManager from '../MCPAuthorizationManager.vue';
import { pluginRegistry } from '../../plugins';
</script>
<template>
  <div>
    <PluginManager /><MCPAuthorizationManager
      v-if="!pluginRegistry.installed.some((plugin) => plugin.id === 'mcp')"
    />
  </div>
</template>
