<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { Modal, message } from 'ant-design-vue';
import { useSettingsStore } from '@/stores/settings';

const settingsStore = useSettingsStore();

const loadingList = ref(false);
const loadingSource = ref(false);
const saving = ref(false);
const testing = ref(false);

const selectedAdapterId = ref('');
const sourceCode = ref('');
const createVisible = ref(false);
const newAdapterId = ref('');
const testWorkerName = ref('');
const testInput = ref({});
const testResult = ref(null);

const adapters = computed(() => settingsStore.adaptersMeta);
const selectedAdapter = computed(() => adapters.value.find(item => item.id === selectedAdapterId.value) || null);
const availableWorkers = computed(() => {
    const workers = [];
    for (const instance of settingsStore.workerConfig || []) {
        for (const worker of instance.workers || []) {
            workers.push({
                label: `${worker.name}${instance.name ? ` (${instance.name})` : ''}`,
                value: worker.name
            });
        }
    }
    return workers;
});

function buildTemplate(adapterId) {
    return `const TARGET_URL = 'https://example.com';

export const manifest = {
  id: '${adapterId}',
  name: '${adapterId}',
  provider: {
    type: 'openai-images-generations',
    models: ['gpt-image-2']
  },
  navigationHandlers: [],
  getTargetUrl() {
    return TARGET_URL;
  },
  async execute(ctx, input) {
    const { page, api } = ctx;
    api.log('info', '开始执行动态适配器', {
      providerType: 'openai-images-generations',
      model: input.model,
      promptLength: String(input.prompt || '').length
    });
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    return {
      success: false,
      error: {
        message: '请编辑脚本后再测试',
        retryable: false
      }
    };
  }
};
`;
}

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
}

function buildInitialInput(adapter) {
    const initial = {};
    const fields = adapter?.inputSchema?.fields || [];
    for (const field of fields) {
        if (field.type === 'file') {
            initial[field.key] = field.multiple === false ? null : [];
            continue;
        }
        if (field.defaultValue !== undefined) {
            initial[field.key] = cloneValue(field.defaultValue);
            continue;
        }
        if (field.key === 'model') {
            initial[field.key] = adapter?.models?.[0] || '';
            continue;
        }
        if (field.type === 'switch') {
            initial[field.key] = false;
            continue;
        }
        initial[field.key] = '';
    }
    return initial;
}

function resetTestInput(adapter) {
    testInput.value = buildInitialInput(adapter);
    testResult.value = null;
}

function getFieldOptions(field) {
    if (Array.isArray(field.options) && field.options.length > 0) {
        return field.options;
    }
    if (field.key === 'model') {
        return (selectedAdapter.value?.models || []).map(model => ({ label: model, value: model }));
    }
    return [];
}

function getUploadedFiles(field) {
    const value = testInput.value[field.key];
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

const fileToDataUrl = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
    });
};

async function beforeUpload(field, file) {
    try {
        const dataUrl = await fileToDataUrl(file);
        const item = {
            uid: file.uid,
            fileName: file.name,
            mimeType: file.type,
            dataUrl
        };

        if (field.multiple === false) {
            testInput.value[field.key] = item;
        } else {
            const current = getUploadedFiles(field);
            testInput.value[field.key] = [...current, item];
        }
    } catch (e) {
        message.error(`文件读取失败: ${e.message}`);
    }
    return false;
}

function removeUploadedFile(field, uid) {
    if (field.multiple === false) {
        testInput.value[field.key] = null;
        return;
    }
    testInput.value[field.key] = getUploadedFiles(field).filter(item => item.uid !== uid);
}

function serializeFieldValue(field, value) {
    if (field.type === 'json') {
        if (typeof value === 'string') {
            return JSON.parse(value);
        }
        return value;
    }
    if (field.type === 'file') {
        if (!value) {
            return field.multiple === false ? null : [];
        }
        if (field.multiple === false) {
            return {
                fileName: value.fileName,
                mimeType: value.mimeType,
                dataUrl: value.dataUrl
            };
        }
        return value.map(item => ({
            fileName: item.fileName,
            mimeType: item.mimeType,
            dataUrl: item.dataUrl
        }));
    }
    return value;
}

function buildTestPayload() {
    const adapter = selectedAdapter.value;
    const fields = adapter?.inputSchema?.fields || [];
    const input = {};
    for (const field of fields) {
        input[field.key] = serializeFieldValue(field, testInput.value[field.key]);
    }
    return input;
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
        resetTestInput(selectedAdapter.value);
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
            try {
                const currentId = selectedAdapterId.value;
                await settingsStore.deleteAdapterSource(currentId);
                selectedAdapterId.value = '';
                sourceCode.value = '';
                testResult.value = null;
                await refreshAdapters();
            } catch (e) {
                Modal.error({ title: '删除失败', content: e.message });
            }
        }
    });
}

async function handleTest() {
    if (!selectedAdapterId.value) return;
    testing.value = true;
    testResult.value = null;
    try {
        const payload = {
            workerName: testWorkerName.value || null,
            input: buildTestPayload()
        };
        testResult.value = await settingsStore.testAdapter(selectedAdapterId.value, payload);
        if (testResult.value.success) {
            message.success('测试执行完成');
        } else {
            message.warning('测试执行返回错误');
        }
    } catch (e) {
        testResult.value = {
            success: false,
            result: {
                error: e.message
            }
        };
        message.error(e.message);
    } finally {
        testing.value = false;
    }
}

watch(selectedAdapterId, async (adapterId) => {
    await loadSource(adapterId);
    resetTestInput(selectedAdapter.value);
});

onMounted(async () => {
    await Promise.all([
        refreshAdapters(),
        settingsStore.fetchWorkerConfig()
    ]);
    if (availableWorkers.value.length > 0 && !testWorkerName.value) {
        testWorkerName.value = availableWorkers.value[0].value;
    }
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
                            <a-list-item @click="selectedAdapterId = item.id"
                                :style="{ cursor: 'pointer', background: selectedAdapterId === item.id ? '#e6f4ff' : '' }">
                                <div style="width: 100%;">
                                    <div style="display: flex; justify-content: space-between; gap: 8px; align-items: center;">
                                        <span style="font-weight: 600; word-break: break-all;">{{ item.id }}</span>
                                        <a-tag :color="item.valid ? 'success' : 'error'">{{ item.valid ? '有效' : '无效' }}</a-tag>
                                    </div>
                                    <div style="font-size: 12px; color: #8c8c8c; margin-top: 4px;">
                                        {{ item.name || item.id }}
                                    </div>
                                    <div v-if="item.providerType" style="font-size: 12px; color: #8c8c8c; margin-top: 4px;">
                                        {{ item.providerType }}
                                    </div>
                                    <div v-if="item.error" style="font-size: 12px; color: #ff4d4f; margin-top: 4px; word-break: break-all;">
                                        {{ item.error }}
                                    </div>
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
                        <div style="margin-bottom: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
                            <a-tag color="blue">{{ selectedAdapter?.providerType }}</a-tag>
                            <a-tag v-for="model in selectedAdapter?.models || []" :key="model">{{ model }}</a-tag>
                        </div>

                        <a-textarea v-model:value="sourceCode" :auto-size="{ minRows: 24, maxRows: 32 }" :disabled="loadingSource"
                            style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;" />

                        <a-divider />

                        <div style="font-weight: 600; margin-bottom: 12px;">测试执行</div>
                        <a-row :gutter="12" style="margin-bottom: 12px;">
                            <a-col :xs="24" :md="12">
                                <div style="margin-bottom: 6px; font-size: 12px; color: #8c8c8c;">Worker</div>
                                <a-select v-model:value="testWorkerName" style="width: 100%;" :options="availableWorkers" />
                            </a-col>
                            <a-col :xs="24" :md="12" style="display: flex; align-items: flex-end; justify-content: flex-end;">
                                <a-button type="primary" @click="handleTest" :loading="testing" :disabled="!selectedAdapterId || !testWorkerName">
                                    测试执行
                                </a-button>
                            </a-col>
                        </a-row>

                        <template v-for="field in selectedAdapter?.inputSchema?.fields || []" :key="field.key">
                            <div style="margin-top: 12px;">
                                <div style="margin-bottom: 6px; font-size: 12px; color: #8c8c8c;">
                                    {{ field.label || field.key }}
                                </div>

                                <a-textarea v-if="field.type === 'textarea' || field.type === 'json'"
                                    v-model:value="testInput[field.key]"
                                    :rows="field.type === 'json' ? 10 : 4"
                                    :placeholder="field.placeholder || ''" />

                                <a-input v-else-if="field.type === 'input'"
                                    v-model:value="testInput[field.key]"
                                    :placeholder="field.placeholder || ''" />

                                <a-input-number v-else-if="field.type === 'number'"
                                    v-model:value="testInput[field.key]"
                                    :min="field.min ?? 0"
                                    :max="field.max ?? 100"
                                    style="width: 100%;" />

                                <a-select v-else-if="field.type === 'select'"
                                    v-model:value="testInput[field.key]"
                                    style="width: 100%;"
                                    :options="getFieldOptions(field)"
                                    :disabled="field.disabled" />

                                <a-switch v-else-if="field.type === 'switch'"
                                    v-model:checked="testInput[field.key]" />

                                <template v-else-if="field.type === 'file'">
                                    <a-upload-dragger :file-list="[]"
                                        :multiple="field.multiple !== false"
                                        :before-upload="file => beforeUpload(field, file)"
                                        :accept="field.accept || '*/*'"
                                        :show-upload-list="false"
                                        style="padding: 8px;">
                                        <p style="font-size: 12px; margin: 0; color: #8c8c8c;">
                                            点击或拖拽上传{{ field.multiple === false ? '文件' : '文件列表' }}
                                        </p>
                                    </a-upload-dragger>
                                    <div v-if="getUploadedFiles(field).length > 0" style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">
                                        <a-tag v-for="item in getUploadedFiles(field)" :key="item.uid" closable @close="removeUploadedFile(field, item.uid)">
                                            {{ item.fileName }}
                                        </a-tag>
                                    </div>
                                </template>
                            </div>
                        </template>

                        <div v-if="testResult" style="margin-top: 16px;">
                            <div style="font-weight: 600; margin-bottom: 8px;">测试结果</div>
                            <a-alert :type="testResult.success ? 'success' : 'error'"
                                :message="testResult.success ? '执行成功' : (testResult.result?.error?.message || testResult.result?.error || '执行失败')"
                                show-icon />
                            <pre style="margin-top: 12px; background: #fafafa; padding: 12px; border-radius: 6px; overflow: auto; white-space: pre-wrap; word-break: break-all;">{{ JSON.stringify(testResult.result, null, 2) }}</pre>
                        </div>
                    </template>
                </a-card>
            </a-col>
        </a-row>

        <a-modal v-model:open="createVisible" title="新建适配器脚本" ok-text="创建" cancel-text="取消" @ok="handleCreate">
            <div style="font-size: 12px; color: #8c8c8c; margin-bottom: 8px;">
                适配器 ID 将作为文件名与 manifest.id，建议只使用字母、数字、点、下划线和中划线。
            </div>
            <a-input v-model:value="newAdapterId" placeholder="例如: chatgpt_image_generate" />
        </a-modal>
    </a-layout>
</template>
