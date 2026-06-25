<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { Modal, message } from 'ant-design-vue';
import { useSettingsStore } from '@/stores/settings';

const settingsStore = useSettingsStore();

const loadingList = ref(false);
const loadingSource = ref(false);
const saving = ref(false);
const deleting = ref(false);
const selectedAdapterId = ref('');
const createVisible = ref(false);
const newAdapterId = ref('');

const inputJsonSchemaError = ref('');

// 表单字段（创建时为可输入 id；编辑时 id 锁定为只读）
const form = ref({
    id: '',
    name: '',
    description: '',
    homePageUrl: '',
    inputJsonSchemaText: '{\n  "type": "object",\n  "properties": {}\n}',
    script: ''
});

const adapters = computed(() => settingsStore.adaptersMeta);
const selectedAdapter = computed(() => adapters.value.find(item => item.id === selectedAdapterId.value) || null);

function blankTemplate(id) {
    return {
        id,
        name: id,
        description: '',
        homePageUrl: '',
        inputJsonSchemaText: '{\n  "type": "object",\n  "properties": {}\n}',
        script: [
            'await page.goto(\'https://example.com\', { waitUntil: \'domcontentloaded\' });',
            'return { url: page.url(), title: await page.title() };'
        ].join('\n')
    };
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

async function loadAdapter(adapterId) {
    if (!adapterId) {
        form.value = { ...blankTemplate(''), script: '' };
        return;
    }
    loadingSource.value = true;
    try {
        const manifest = await settingsStore.fetchAdapter(adapterId);
        form.value = {
            id: manifest.id || adapterId,
            name: manifest.name || adapterId,
            description: manifest.description || '',
            homePageUrl: manifest.homePageUrl || '',
            inputJsonSchemaText: manifest.inputJsonSchema
                ? JSON.stringify(manifest.inputJsonSchema, null, 2)
                : '{\n  "type": "object",\n  "properties": {}\n}',
            script: manifest.script || ''
        };
    } catch (e) {
        message.error(e.message);
    } finally {
        loadingSource.value = false;
    }
}

function buildPayloadFromForm() {
    const trimmedId = String(form.value.id || '').trim();
    if (!trimmedId) {
        throw new Error('缺少 id');
    }
    if (!String(form.value.name || '').trim()) {
        throw new Error('缺少 name');
    }
    if (typeof form.value.script !== 'string' || !form.value.script.trim()) {
        throw new Error('script 不能为空');
    }

    let inputSchema = null;
    const schemaText = String(form.value.inputJsonSchemaText || '').trim();
    if (schemaText) {
        try {
            inputSchema = JSON.parse(schemaText);
            inputJsonSchemaError.value = '';
        } catch (e) {
            const detail = `inputJsonSchema 不是合法 JSON: ${e.message}`;
            inputJsonSchemaError.value = detail;
            throw new Error(detail);
        }
    }

    return {
        id: trimmedId,
        name: String(form.value.name).trim(),
        description: String(form.value.description || '').trim(),
        homePageUrl: String(form.value.homePageUrl || '').trim(),
        inputJsonSchema: inputSchema,
        script: form.value.script
    };
}

async function handleSave() {
    if (!selectedAdapterId.value) return;
    saving.value = true;
    try {
        const payload = buildPayloadFromForm();
        inputJsonSchemaError.value = '';
        await settingsStore.saveAdapter(selectedAdapterId.value, payload);
        await refreshAdapters();
        await loadAdapter(selectedAdapterId.value);
    } catch (e) {
        const msg = String(e.message || '');
        if (msg.includes('inputJsonSchema 不是合法 JSON')) {
            inputJsonSchemaError.value = msg;
            message.warning('inputJsonSchema 不是合法 JSON，请修正后再保存');
        } else {
            Modal.error({ title: '保存失败', content: msg });
        }
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
        const tpl = blankTemplate(adapterId);
        await settingsStore.createAdapter(tpl);
        createVisible.value = false;
        await refreshAdapters();
        selectedAdapterId.value = adapterId;
    } catch (e) {
        Modal.error({ title: '创建失败', content: e.message });
    }
}

function handleDelete() {
    if (!selectedAdapterId.value) return;
    if (deleting.value) return;
    deleting.value = true;
    const targetId = selectedAdapterId.value;
    Modal.confirm({
        title: '删除适配器脚本',
        content: `确定要删除 ${targetId} 吗？`,
        okText: '删除',
        okType: 'danger',
        cancelText: '取消',
        onCancel() {
            deleting.value = false;
        },
        async onOk() {
            try {
                await settingsStore.deleteAdapterSource(targetId);
                selectedAdapterId.value = '';
                form.value = { ...blankTemplate(''), script: '' };
                await refreshAdapters();
            } catch (e) {
                Modal.error({ title: '删除失败', content: e.message });
                selectedAdapterId.value = targetId;
                await refreshAdapters();
            } finally {
                deleting.value = false;
            }
        }
    });
}

watch(selectedAdapterId, async (adapterId) => {
    await loadAdapter(adapterId);
});

watch(() => form.value.inputJsonSchemaText, (text) => {
    if (!text) {
        inputJsonSchemaError.value = '';
        return;
    }
    try {
        JSON.parse(text);
        inputJsonSchemaError.value = '';
    } catch (e) {
        inputJsonSchemaError.value = `inputJsonSchema 不是合法 JSON: ${e.message}`;
    }
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
                            <a-button danger @click="handleDelete" :disabled="!selectedAdapterId || deleting" :loading="deleting">删除</a-button>
                            <a-button type="primary" @click="handleSave" :loading="saving" :disabled="!selectedAdapterId">保存</a-button>
                        </a-space>
                    </template>

                    <a-empty v-if="!selectedAdapterId" description="请选择或创建一个适配器脚本" />
                    <template v-else>
                        <a-alert
                            type="info"
                            show-icon
                            style="margin-bottom: 16px;"
                            message="脚本以 manifest.script 字符串形式提供。执行器注入 page, input, api, helpers, runtime 五个对象。"
                        />

                        <a-form layout="vertical" :disabled="loadingSource">
                            <a-row :gutter="12">
                                <a-col :xs="24" :md="12">
                                    <a-form-item label="id (创建后不可修改)">
                                        <a-input v-model:value="form.id" disabled />
                                    </a-form-item>
                                </a-col>
                                <a-col :xs="24" :md="12">
                                    <a-form-item label="name">
                                        <a-input v-model:value="form.name" placeholder="展示用名称" />
                                    </a-form-item>
                                </a-col>
                            </a-row>
                            <a-row :gutter="12">
                                <a-col :xs="24" :md="12">
                                    <a-form-item label="description">
                                        <a-input v-model:value="form.description" placeholder="可选：脚本用途说明" />
                                    </a-form-item>
                                </a-col>
                                <a-col :xs="24" :md="12">
                                    <a-form-item label="homePageUrl">
                                        <a-input v-model:value="form.homePageUrl" placeholder="例如：https://chatgpt.com" />
                                    </a-form-item>
                                </a-col>
                            </a-row>
                            <a-form-item label="inputJsonSchema (JSON，可选，仅用于 UI/文档)">
                                <a-textarea
                                    v-model:value="form.inputJsonSchemaText"
                                    :auto-size="{ minRows: 4, maxRows: 10 }"
                                    style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;"
                                />
                            </a-form-item>
                            <a-form-item label="script (JavaScript 字符串)">
                                <a-textarea
                                    v-model:value="form.script"
                                    :auto-size="{ minRows: 18, maxRows: 36 }"
                                    style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;"
                                />
                            </a-form-item>
                        </a-form>
                    </template>
                </a-card>
            </a-col>
        </a-row>

        <a-modal v-model:open="createVisible" title="新建适配器脚本" ok-text="创建" cancel-text="取消" @ok="handleCreate">
            <div style="font-size: 12px; color: #8c8c8c; margin-bottom: 8px;">
                适配器 ID 将作为文件名、manifest.id 与接口路径 /api/{adapter_id}，创建后不可修改。
            </div>
            <a-input v-model:value="newAdapterId" placeholder="例如: chatgpt" />
        </a-modal>
    </a-layout>
</template>

<style scoped>
.label {
    font-size: 12px;
    color: #8c8c8c;
    margin-bottom: 4px;
}
</style>
