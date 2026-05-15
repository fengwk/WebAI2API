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
const testImages = ref([]);

const testForm = ref({
    workerName: '',
    modelId: '',
    prompt: 'test'
});

const testResult = ref(null);

const adapters = computed(() => settingsStore.adaptersMeta);
const selectedAdapter = computed(() => adapters.value.find(a => a.id === selectedAdapterId.value) || null);
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
    return `export const manifest = {
  id: '${adapterId}',
  displayName: '${adapterId}',
  description: 'dynamic adapter',
  models: [
    { id: '${adapterId}-model', imagePolicy: 'optional', type: 'image' }
  ],
  navigationHandlers: [],

  async generate(ctx, prompt, imagePaths, modelId, meta) {
    const { page, context, api } = ctx;

    api.log('info', '开始执行动态适配器', { modelId, promptLength: prompt.length, imageCount: imagePaths.length });

    await page.goto('https://example.com');

    return { error: '请编辑脚本后再测试' };
  }
};
`;
}

const fileToBase64 = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
    });
};

const beforeUpload = (file) => {
    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
        message.error('仅支持 PNG, JPEG, GIF, WebP 格式');
        return false;
    }
    if (testImages.value.length >= 10) {
        message.error('最多上传 10 张图片');
        return false;
    }
    return false;
};

const handleImageChange = async (info) => {
    const file = info.file;
    if (file.status === 'removed') {
        testImages.value = testImages.value.filter(f => f.uid !== file.uid);
        return;
    }
    try {
        const base64 = await fileToBase64(file.originFileObj || file);
        testImages.value.push({ uid: file.uid, name: file.name, base64 });
    } catch {
        message.error('图片读取失败');
    }
};

async function refreshAdapters() {
    loadingList.value = true;
    try {
        await settingsStore.fetchAdaptersMeta();
        if (!selectedAdapterId.value && adapters.value.length > 0) {
            selectedAdapterId.value = adapters.value[0].id;
        } else if (selectedAdapterId.value && !adapters.value.some(a => a.id === selectedAdapterId.value)) {
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
        testResult.value = null;
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
        testResult.value = await settingsStore.testAdapter(selectedAdapterId.value, {
            workerName: testForm.value.workerName || null,
            modelId: testForm.value.modelId || null,
            prompt: testForm.value.prompt || '',
            images: testImages.value.map(item => item.base64)
        });
        if (testResult.value.success) {
            message.success('测试执行完成');
        } else {
            message.warning('测试执行返回错误');
        }
    } catch (e) {
        testResult.value = { success: false, result: { error: e.message } };
        message.error(e.message);
    } finally {
        testing.value = false;
    }
}

watch(selectedAdapterId, async (id) => {
    await loadSource(id);
    const adapter = adapters.value.find(a => a.id === id);
    if (adapter?.models?.length === 1) {
        testForm.value.modelId = adapter.models[0];
    } else if (!adapter?.models?.includes(testForm.value.modelId)) {
        testForm.value.modelId = adapter?.models?.[0] || '';
    }
});

onMounted(async () => {
    await Promise.all([
        refreshAdapters(),
        settingsStore.fetchWorkerConfig()
    ]);
    if (availableWorkers.value.length > 0 && !testForm.value.workerName) {
        testForm.value.workerName = availableWorkers.value[0].value;
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
                                        {{ item.displayName || item.id }}
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
                        <div v-if="selectedAdapter?.description" style="margin-bottom: 12px; color: #8c8c8c;">
                            {{ selectedAdapter.description }}
                        </div>

                        <a-textarea v-model:value="sourceCode" :auto-size="{ minRows: 24, maxRows: 32 }" :disabled="loadingSource"
                            style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;" />

                        <a-divider />

                        <div style="font-weight: 600; margin-bottom: 12px;">测试执行</div>
                        <a-row :gutter="12">
                            <a-col :xs="24" :md="8">
                                <div style="margin-bottom: 6px; font-size: 12px; color: #8c8c8c;">Worker</div>
                                <a-select v-model:value="testForm.workerName" style="width: 100%;" :options="availableWorkers" />
                            </a-col>
                            <a-col :xs="24" :md="8">
                                <div style="margin-bottom: 6px; font-size: 12px; color: #8c8c8c;">模型</div>
                                <a-select v-model:value="testForm.modelId" style="width: 100%;"
                                    :options="(selectedAdapter?.models || []).map(m => ({ label: m, value: m }))"
                                    :disabled="(selectedAdapter?.models || []).length <= 1" />
                            </a-col>
                            <a-col :xs="24" :md="8" style="display: flex; align-items: flex-end; justify-content: flex-end;">
                                <a-button type="primary" @click="handleTest" :loading="testing" :disabled="!selectedAdapterId || !testForm.workerName">
                                    测试执行
                                </a-button>
                            </a-col>
                        </a-row>

                        <div style="margin-top: 12px;">
                            <div style="margin-bottom: 6px; font-size: 12px; color: #8c8c8c;">Prompt</div>
                            <a-textarea v-model:value="testForm.prompt" :rows="4" />
                        </div>

                        <div style="margin-top: 12px;">
                            <div style="margin-bottom: 6px; font-size: 12px; color: #8c8c8c;">测试图片 ({{ testImages.length }}/10)</div>
                            <a-upload-dragger :file-list="[]" :multiple="true" :before-upload="beforeUpload" @change="handleImageChange"
                                accept=".png,.jpg,.jpeg,.gif,.webp" :show-upload-list="false" style="padding: 8px;">
                                <p style="font-size: 12px; margin: 0; color: #8c8c8c;">点击或拖拽上传图片用于测试</p>
                            </a-upload-dragger>
                            <div v-if="testImages.length > 0" style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">
                                <a-tag v-for="img in testImages" :key="img.uid" closable
                                    @close="testImages = testImages.filter(i => i.uid !== img.uid)">
                                    {{ img.name.slice(0, 15) }}{{ img.name.length > 15 ? '...' : '' }}
                                </a-tag>
                            </div>
                        </div>

                        <div v-if="testResult" style="margin-top: 16px;">
                            <div style="font-weight: 600; margin-bottom: 8px;">测试结果</div>
                            <a-alert :type="testResult.success ? 'success' : 'error'"
                                :message="testResult.success ? '执行成功' : (testResult.result?.error || '执行失败')"
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
            <a-input v-model:value="newAdapterId" placeholder="例如: chatgpt" />
        </a-modal>
    </a-layout>
</template>
