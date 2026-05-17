<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { Modal, message } from 'ant-design-vue';
import { useSettingsStore } from '@/stores/settings';

const settingsStore = useSettingsStore();

const loadingList = ref(false);
const loadingSource = ref(false);
const saving = ref(false);
const selectedAdapterId = ref('');
const sourceCode = ref('');
const createVisible = ref(false);
const newAdapterId = ref('');

const adapters = computed(() => settingsStore.adaptersMeta);
const selectedAdapter = computed(() => adapters.value.find(item => item.id === selectedAdapterId.value) || null);

function buildTemplate(adapterId) {
    return `export const manifest = {
  id: '${adapterId}',
  name: '${adapterId}',
  inputJsonSchema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: {
        type: 'string',
        title: 'Prompt',
        description: '输入提示词',
        'x-ui': 'textarea'
      }
    }
  },
  outputJsonSchema: {
    type: 'object',
    required: ['message'],
    properties: {
      message: {
        type: 'string',
        title: 'Message'
      }
    }
  },
  async execute(ctx, input) {
    const { page, api } = ctx;
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    api.log('info', '开始执行适配器', { promptLength: String(input.prompt || '').length });
    return { message: '请编辑脚本后再调用 /api/${adapterId}' };
  }
};
`;
}

async function refreshAdapters() {
    loadingList.value = true;
    try {
        await settingsStore.fetchAdaptersMeta();
        if (!selectedAdapterId.value && adapters.value.length > 0) {
            selectedAdapterId.value = adapters.value[0].id;
        } else if (selectedAdapterId.value && !adapters.value.some(item => item.id === selectedAdapterId.value)) {
            selectedAdapterId.value = adapters.value[0]?.id || '';
        }
    } finally {
        loadingList.value = false;
    }
}

async function loadSource(adapterId) {
    if (!adapterId) {
        sourceCode.value = '';
        return;
    }
    loadingSource.value = true;
    try {
        sourceCode.value = await settingsStore.fetchAdapterSource(adapterId);
    } catch (e) {
        message.error(e.message);
        sourceCode.value = '';
    } finally {
        loadingSource.value = false;
    }
}

async function handleSave() {
    if (!selectedAdapterId.value) return;
    saving.value = true;
    try {
        await settingsStore.saveAdapterSource(selectedAdapterId.value, sourceCode.value);
        await refreshAdapters();
        await loadSource(selectedAdapterId.value);
    } catch (e) {
        Modal.error({ title: '保存失败', content: e.message });
    } finally {
        saving.value = false;
    }
}

function openCreateModal() {
    newAdapterId.value = '';
    createVisible.value = true;
}

async function handleCreate() {
    const adapterId = newAdapterId.value.trim();
    if (!adapterId) {
        message.warning('请输入适配器 ID');
        return;
    }
    try {
        await settingsStore.saveAdapterSource(adapterId, buildTemplate(adapterId));
        createVisible.value = false;
        await refreshAdapters();
        selectedAdapterId.value = adapterId;
    } catch (e) {
        Modal.error({ title: '创建失败', content: e.message });
    }
}

function handleDelete() {
    if (!selectedAdapterId.value) return;
    Modal.confirm({
        title: '删除适配器脚本',
        content: `确定要删除 ${selectedAdapterId.value} 吗？`,
        okText: '删除',
        okType: 'danger',
        cancelText: '取消',
        async onOk() {
            await settingsStore.deleteAdapterSource(selectedAdapterId.value);
            selectedAdapterId.value = '';
            sourceCode.value = '';
            await refreshAdapters();
        }
    });
}

watch(selectedAdapterId, async (adapterId) => {
    await loadSource(adapterId);
});

onMounted(async () => {
    await refreshAdapters();
});
</script>

<template>
    <a-layout style="background: transparent; gap: 16px;">
        <a-row :gutter="16">
            <a-col :xs="24" :lg="7">
                <a-card title="适配器脚本" :bordered="false">
                    <template #extra>
                        <a-space>
                            <a-button type="link" @click="refreshAdapters" :loading="loadingList">刷新</a-button>
                            <a-button type="primary" size="small" @click="openCreateModal">新建</a-button>
                        </a-space>
                    </template>

                    <a-empty v-if="adapters.length === 0" description="暂无适配器脚本，请先新建" />

                    <a-list v-else :data-source="adapters" size="small" bordered>
                        <template #renderItem="{ item }">
                            <a-list-item @click="selectedAdapterId = item.id" :style="{ cursor: 'pointer', background: selectedAdapterId === item.id ? '#e6f4ff' : '' }">
                                <div style="width: 100%;">
                                    <div style="display: flex; justify-content: space-between; gap: 8px; align-items: center;">
                                        <span style="font-weight: 600; word-break: break-all;">{{ item.id }}</span>
                                        <a-tag :color="item.valid ? 'success' : 'error'">{{ item.valid ? '有效' : '无效' }}</a-tag>
                                    </div>
                                    <div style="font-size: 12px; color: #8c8c8c; margin-top: 4px;">{{ item.name || item.id }}</div>
                                    <div style="font-size: 12px; color: #8c8c8c; margin-top: 4px;"><code>{{ item.endpoint }}</code></div>
                                    <div v-if="item.error" style="font-size: 12px; color: #ff4d4f; margin-top: 4px; word-break: break-all;">{{ item.error }}</div>
                                </div>
                            </a-list-item>
                        </template>
                    </a-list>
                </a-card>
            </a-col>

            <a-col :xs="24" :lg="17">
                <a-card :title="selectedAdapterId ? `编辑脚本 - ${selectedAdapterId}` : '适配器脚本编辑器'" :bordered="false">
                    <template #extra>
                        <a-space>
                            <a-button danger @click="handleDelete" :disabled="!selectedAdapterId">删除</a-button>
                            <a-button type="primary" @click="handleSave" :loading="saving" :disabled="!selectedAdapterId">保存</a-button>
                        </a-space>
                    </template>

                    <a-empty v-if="!selectedAdapterId" description="请选择或创建一个适配器脚本" />
                    <template v-else>
                        <div class="schema-panel">
                            <div>
                                <div class="schema-title">接口路径</div>
                                <code>{{ selectedAdapter?.endpoint }}</code>
                            </div>
                            <div>
                                <div class="schema-title">输入 Schema</div>
                                <pre class="schema-json">{{ JSON.stringify(selectedAdapter?.inputJsonSchema, null, 2) }}</pre>
                            </div>
                            <div>
                                <div class="schema-title">输出 Schema</div>
                                <pre class="schema-json">{{ JSON.stringify(selectedAdapter?.outputJsonSchema, null, 2) }}</pre>
                            </div>
                        </div>

                        <a-alert type="info" show-icon style="margin-bottom: 12px;"
                            message="保存时仅做静态校验。接口测试请前往“请求 API”，页面级排障请使用 /admin/debug/run。" />

                        <a-textarea v-model:value="sourceCode" :auto-size="{ minRows: 24, maxRows: 32 }" :disabled="loadingSource" style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;" />
                    </template>
                </a-card>
            </a-col>
        </a-row>

        <a-modal v-model:open="createVisible" title="新建适配器脚本" ok-text="创建" cancel-text="取消" @ok="handleCreate">
            <div style="font-size: 12px; color: #8c8c8c; margin-bottom: 8px;">
                适配器 ID 将同时作为文件名、manifest.id 与接口路径 /api/{adapter_id}。
            </div>
            <a-input v-model:value="newAdapterId" placeholder="例如: chatgpt" />
        </a-modal>
    </a-layout>
</template>

<style scoped>
.schema-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 12px;
}

.schema-title {
    font-weight: 600;
    margin-bottom: 4px;
}

.schema-json {
    background: #fafafa;
    border: 1px solid #f0f0f0;
    border-radius: 6px;
    padding: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 12px;
    max-height: 240px;
    overflow: auto;
}
</style>
