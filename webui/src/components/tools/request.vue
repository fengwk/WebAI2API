<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import { message, Modal } from 'ant-design-vue';
import {
    ReloadOutlined,
    DeleteOutlined,
    EyeOutlined,
    CheckCircleOutlined,
    CloseCircleOutlined,
    ClockCircleOutlined,
    RocketOutlined,
    CopyOutlined,
    RedoOutlined
} from '@ant-design/icons-vue';
import SchemaField from './SchemaField.vue';

const settingsStore = useSettingsStore();

const loading = ref(false);
const records = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const statusFilter = ref('all');
const adapterFilter = ref('');
const searchText = ref('');
const drawerVisible = ref(false);
const currentRecord = ref(null);
const detailLoading = ref(false);
const previewModalVisible = ref(false);
const previewContent = ref('');
const previewTitle = ref('预览');
const selectedAdapterId = ref('');
const formValue = ref({});
const sending = ref(false);
const latestResponse = ref(null);
const latestError = ref('');
const autoRefreshEnabled = ref(true);

let autoRefreshInterval = null;
let searchTimeout = null;

function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function inferSchemaType(schema) {
    if (schema?.type) return schema.type;
    if (schema?.enum) return 'string';
    if (schema?.properties) return 'object';
    if (schema?.items) return 'array';
    return 'string';
}

function isFileObjectSchema(schema) {
    if (!schema || inferSchemaType(schema) !== 'object') return false;
    const properties = schema.properties || {};
    return 'fileName' in properties && 'mimeType' in properties && 'base64' in properties;
}

function isMultiFileSchema(schema) {
    return schema?.['x-ui'] === 'files' || (inferSchemaType(schema) === 'array' && isFileObjectSchema(schema.items));
}

function buildDefaultValue(schema) {
    if (!schema) return null;
    if (schema.default !== undefined) return deepClone(schema.default);
    if (schema.enum?.length) return schema.enum[0];

    const schemaType = inferSchemaType(schema);
    if (schema?.['x-ui'] === 'file' || isFileObjectSchema(schema)) return null;
    if (isMultiFileSchema(schema)) return [];
    if (schemaType === 'object') {
        const result = {};
        for (const [key, childSchema] of Object.entries(schema.properties || {})) {
            if (childSchema.default !== undefined || (schema.required || []).includes(key)) {
                result[key] = buildDefaultValue(childSchema);
            }
        }
        return result;
    }
    if (schemaType === 'array') return [];
    if (schemaType === 'boolean') return false;
    if (schemaType === 'number' || schemaType === 'integer') return 0;
    return '';
}

const adapters = computed(() => settingsStore.adaptersMeta.filter(item => item.valid !== false));
const adapterOptions = computed(() => adapters.value.map(item => ({ label: item.name || item.id, value: item.id })));
const selectedAdapter = computed(() => adapters.value.find(item => item.id === selectedAdapterId.value) || null);
const adapterEndpoint = computed(() => selectedAdapter.value?.endpoint || (selectedAdapter.value ? `/api/${selectedAdapter.value.id}` : ''));
const adapterInputSchema = computed(() => selectedAdapter.value?.inputJsonSchema || null);
const adapterOutputSchema = computed(() => selectedAdapter.value?.outputJsonSchema || null);

const historyColumns = [
    { title: '状态', dataIndex: 'status', key: 'status', width: 80, align: 'center' },
    { title: '接口', dataIndex: 'adapter_id', key: 'adapter_id', width: 150 },
    { title: '请求', dataIndex: 'request_summary', key: 'request_summary', width: 260 },
    { title: '响应', dataIndex: 'response_summary', key: 'response_summary', width: 320 },
    { title: '时间', dataIndex: 'created_at', key: 'created_at', width: 140 },
    { title: '耗时', dataIndex: 'duration_ms', key: 'duration_ms', width: 80, align: 'right' },
    { title: '', key: 'action', width: 120, align: 'center', fixed: 'right' }
];

function formatTime(timestamp) {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function formatDuration(ms) {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function truncateText(text, maxLen = 140) {
    if (!text) return '-';
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function getStatusColor(status) {
    if (status === 'success') return 'success';
    if (status === 'failed') return 'error';
    return 'processing';
}

function resetFormFromSchema() {
    formValue.value = buildDefaultValue(adapterInputSchema.value || { type: 'object', properties: {} }) || {};
}

watch(selectedAdapterId, () => {
    resetFormFromSchema();
    latestResponse.value = null;
    latestError.value = '';
});

watch(searchText, () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        page.value = 1;
        fetchHistory();
    }, 300);
});

watch([statusFilter, adapterFilter], () => {
    page.value = 1;
    fetchHistory();
});

function buildCurlCommand() {
    if (!selectedAdapter.value) return '';
    const tokenHeader = settingsStore.token
        ? `  -H "Authorization: Bearer ${settingsStore.token}" \\\n+`
        : '';
    return `curl -X POST ${window.location.origin}${adapterEndpoint.value} \\
${tokenHeader}  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(formValue.value)}'`;
}

async function fetchAdapters() {
    await settingsStore.fetchAdaptersMeta();
    if (!selectedAdapterId.value && adapters.value.length > 0) {
        selectedAdapterId.value = adapters.value[0].id;
    }
}

async function fetchHistory() {
    loading.value = true;
    try {
        const params = new URLSearchParams({
            page: String(page.value),
            pageSize: String(pageSize.value)
        });
        if (statusFilter.value && statusFilter.value !== 'all') params.append('status', statusFilter.value);
        if (adapterFilter.value) params.append('adapter', adapterFilter.value);
        if (searchText.value) params.append('search', searchText.value);
        const res = await fetch(`/admin/history?${params.toString()}`, { headers: settingsStore.getHeaders() });
        if (res.ok) {
            const data = await res.json();
            records.value = data.items || [];
            total.value = data.total || 0;
        }
    } catch (e) {
        message.error(`获取历史失败: ${e.message}`);
    } finally {
        loading.value = false;
    }
}

function startAutoRefresh() {
    if (autoRefreshInterval) return;
    autoRefreshInterval = setInterval(() => {
        if (autoRefreshEnabled.value) {
            fetchHistory();
        }
    }, 3000);
}

function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }
}

async function sendRequest() {
    if (!selectedAdapter.value) {
        message.warning('请先选择适配器');
        return;
    }

    sending.value = true;
    latestResponse.value = null;
    latestError.value = '';
    try {
        const res = await fetch(adapterEndpoint.value, {
            method: 'POST',
            headers: settingsStore.getHeaders(),
            body: JSON.stringify(formValue.value)
        });

        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
            latestError.value = payload.error?.message || payload.message || `HTTP ${res.status}`;
            message.error(latestError.value);
        } else {
            latestResponse.value = payload;
            message.success('请求成功');
        }

        await fetchHistory();
    } catch (e) {
        latestError.value = e.message;
        message.error(`请求失败: ${e.message}`);
    } finally {
        sending.value = false;
    }
}

function previewText(title, content) {
    previewTitle.value = title;
    previewContent.value = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    previewModalVisible.value = true;
}

async function viewDetail(record) {
    drawerVisible.value = true;
    detailLoading.value = true;
    try {
        const res = await fetch(`/admin/history/${record.id}`, { headers: settingsStore.getHeaders() });
        if (res.ok) {
            currentRecord.value = await res.json();
        }
    } catch (e) {
        message.error(`获取详情失败: ${e.message}`);
    } finally {
        detailLoading.value = false;
    }
}

function deleteRecord(record) {
    Modal.confirm({
        title: '确认删除',
        content: `确定要删除记录 ${record.id} 吗？`,
        okText: '删除',
        okType: 'danger',
        cancelText: '取消',
        async onOk() {
            const res = await fetch('/admin/history', {
                method: 'DELETE',
                headers: settingsStore.getHeaders(),
                body: JSON.stringify({ ids: [record.id] })
            });
            if (res.ok) {
                message.success('删除成功');
                await fetchHistory();
            }
        }
    });
}

function resendRecord(record) {
    if (!record.request_body || !record.adapter_id) {
        message.warning('该记录缺少可重发的请求体');
        return;
    }
    selectedAdapterId.value = record.adapter_id;
    formValue.value = deepClone(record.request_body);
}

async function copyText(content) {
    try {
        await navigator.clipboard.writeText(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
        message.success('已复制到剪贴板');
    } catch (e) {
        message.error(`复制失败: ${e.message}`);
    }
}

function handleTableChange(pagination) {
    page.value = pagination.current;
    pageSize.value = pagination.pageSize;
    fetchHistory();
}

onMounted(async () => {
    await Promise.all([fetchAdapters(), fetchHistory()]);
    startAutoRefresh();
});

onUnmounted(() => {
    stopAutoRefresh();
    if (searchTimeout) clearTimeout(searchTimeout);
});
</script>

<template>
    <a-card title="适配器调用" :bordered="false" style="margin-bottom: 24px;">
        <a-row :gutter="16">
            <a-col :xs="24" :lg="8">
                <div style="margin-bottom: 16px;">
                    <div class="label">适配器</div>
                    <a-select v-model:value="selectedAdapterId" style="width: 100%" :options="adapterOptions" placeholder="选择适配器" />
                </div>
                <div v-if="selectedAdapter" class="meta-box">
                    <div><strong>名称：</strong>{{ selectedAdapter.name }}</div>
                    <div><strong>接口：</strong><code>{{ adapterEndpoint }}</code></div>
                </div>
                <div style="margin-top: 16px;">
                    <div class="label">curl 示例（基于当前表单值）</div>
                    <pre class="json-box">{{ buildCurlCommand() }}</pre>
                    <a-button size="small" @click="copyText(buildCurlCommand())">
                        <template #icon><CopyOutlined /></template>
                        复制 curl
                    </a-button>
                </div>
            </a-col>

            <a-col :xs="24" :lg="16">
                <a-alert
                    type="info"
                    show-icon
                    style="margin-bottom: 16px;"
                    message="固定调用方式为 POST /api/{adapter_id}，表单完全由适配器的 inputJsonSchema 驱动。"
                />
                <template v-if="adapterInputSchema">
                    <SchemaField :schema="adapterInputSchema" field-key="input" :model-value="formValue" @update:model-value="value => formValue = value" />
                    <div style="display: flex; gap: 8px; justify-content: flex-end;">
                        <a-button @click="resetFormFromSchema">重置</a-button>
                        <a-button type="primary" :loading="sending" @click="sendRequest">
                            <template #icon><RocketOutlined /></template>
                            调用接口
                        </a-button>
                    </div>
                </template>
                <a-empty v-else description="请选择有效适配器" />
            </a-col>
        </a-row>
    </a-card>

    <a-row :gutter="16" style="margin-bottom: 24px;">
        <a-col :xs="24" :lg="12">
            <a-card title="最近响应" :bordered="false">
                <template v-if="latestResponse">
                    <pre class="json-box">{{ JSON.stringify(latestResponse, null, 2) }}</pre>
                </template>
                <template v-else-if="latestError">
                    <pre class="json-box error-box">{{ latestError }}</pre>
                </template>
                <a-empty v-else description="暂无调用结果" />
            </a-card>
        </a-col>
        <a-col :xs="24" :lg="12">
            <a-card title="输出 Schema" :bordered="false">
                <pre class="json-box">{{ JSON.stringify(adapterOutputSchema, null, 2) }}</pre>
            </a-card>
        </a-col>
    </a-row>

    <a-card title="请求历史" :bordered="false">
        <template #extra>
            <a-space>
                <a-switch v-model:checked="autoRefreshEnabled" checked-children="自动刷新" un-checked-children="手动刷新" />
                <a-button @click="fetchHistory"><template #icon><ReloadOutlined /></template>刷新</a-button>
            </a-space>
        </template>

        <div class="toolbar">
            <a-select v-model:value="statusFilter" style="width: 140px" size="small">
                <a-select-option value="all">全部状态</a-select-option>
                <a-select-option value="success">成功</a-select-option>
                <a-select-option value="failed">失败</a-select-option>
                <a-select-option value="pending">处理中</a-select-option>
            </a-select>
            <a-select v-model:value="adapterFilter" style="width: 180px" size="small" allow-clear placeholder="全部适配器">
                <a-select-option v-for="item in adapterOptions" :key="item.value" :value="item.value">{{ item.label }}</a-select-option>
            </a-select>
            <a-input-search v-model:value="searchText" style="max-width: 280px" size="small" allow-clear placeholder="搜索请求或响应摘要" />
        </div>

        <a-table
            :columns="historyColumns"
            :data-source="records"
            :loading="loading"
            row-key="id"
            size="small"
            :pagination="{
                current: page,
                pageSize,
                total,
                showSizeChanger: true,
                showQuickJumper: true,
                showTotal: total => `共 ${total} 条`
            }"
            :scroll="{ x: 1100 }"
            @change="handleTableChange"
        >
            <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'status'">
                    <a-tag :color="getStatusColor(record.status)">{{ record.status }}</a-tag>
                </template>
                <template v-else-if="column.key === 'adapter_id'">
                    <div>
                        <div><code>{{ record.endpoint_path || `/api/${record.adapter_id}` }}</code></div>
                        <div style="font-size: 12px; color: #8c8c8c;">{{ record.adapter_id || '-' }}</div>
                    </div>
                </template>
                <template v-else-if="column.key === 'request_summary'">
                    <div class="multiline-text clickable" @click="previewText('请求体预览', record.request_body || record.request_summary)">
                        {{ truncateText(record.request_summary, 160) }}
                    </div>
                </template>
                <template v-else-if="column.key === 'response_summary'">
                    <div class="multiline-text clickable" :class="{ 'error-text': record.status === 'failed' }" @click="previewText('响应预览', record.status === 'failed' ? record.error_message : (record.response_body || record.response_summary))">
                        {{ truncateText(record.status === 'failed' ? record.error_message : record.response_summary, 180) }}
                    </div>
                </template>
                <template v-else-if="column.key === 'created_at'">
                    {{ formatTime(record.created_at) }}
                </template>
                <template v-else-if="column.key === 'duration_ms'">
                    {{ formatDuration(record.duration_ms) }}
                </template>
                <template v-else-if="column.key === 'action'">
                    <a-space :size="0">
                        <a-button type="link" size="small" @click="resendRecord(record)">
                            <template #icon><RedoOutlined /></template>
                        </a-button>
                        <a-button type="link" size="small" @click="viewDetail(record)">
                            <template #icon><EyeOutlined /></template>
                        </a-button>
                        <a-button type="link" size="small" danger @click="deleteRecord(record)">
                            <template #icon><DeleteOutlined /></template>
                        </a-button>
                    </a-space>
                </template>
            </template>
        </a-table>
    </a-card>

    <a-drawer v-model:open="drawerVisible" title="请求详情" placement="right" width="720">
        <a-spin :spinning="detailLoading">
            <template v-if="currentRecord">
                <a-descriptions :column="1" size="small" bordered>
                    <a-descriptions-item label="请求 ID"><code>{{ currentRecord.id }}</code></a-descriptions-item>
                    <a-descriptions-item label="适配器">{{ currentRecord.adapter_id }}</a-descriptions-item>
                    <a-descriptions-item label="接口路径"><code>{{ currentRecord.endpoint_path }}</code></a-descriptions-item>
                    <a-descriptions-item label="状态">
                        <a-tag :color="getStatusColor(currentRecord.status)">{{ currentRecord.status }}</a-tag>
                    </a-descriptions-item>
                    <a-descriptions-item label="时间">{{ formatTime(currentRecord.created_at) }}</a-descriptions-item>
                    <a-descriptions-item label="耗时">{{ formatDuration(currentRecord.duration_ms) }}</a-descriptions-item>
                </a-descriptions>

                <a-divider orientation="left">请求体</a-divider>
                <pre class="json-box">{{ JSON.stringify(currentRecord.request_body, null, 2) }}</pre>

                <a-divider orientation="left">响应</a-divider>
                <pre v-if="currentRecord.status === 'failed'" class="json-box error-box">{{ currentRecord.error_message }}</pre>
                <pre v-else class="json-box">{{ JSON.stringify(currentRecord.response_body, null, 2) }}</pre>
            </template>
        </a-spin>
    </a-drawer>

    <a-modal v-model:open="previewModalVisible" :title="previewTitle" :footer="null" width="70%">
        <pre class="json-box">{{ typeof previewContent === 'string' ? previewContent : JSON.stringify(previewContent, null, 2) }}</pre>
    </a-modal>
</template>

<style scoped>
.label {
    font-size: 12px;
    color: #8c8c8c;
    margin-bottom: 4px;
}

.meta-box {
    padding: 12px;
    border: 1px solid #f0f0f0;
    border-radius: 8px;
    background: #fafafa;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.json-box {
    background: #fafafa;
    border: 1px solid #f0f0f0;
    border-radius: 6px;
    padding: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 12px;
    line-height: 1.6;
    max-height: 420px;
    overflow: auto;
}

.error-box {
    color: #ff4d4f;
    background: #fff2f0;
    border-color: #ffccc7;
}

.toolbar {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 16px;
}

.multiline-text {
    font-size: 12px;
    line-height: 1.5;
    max-height: 54px;
    overflow: hidden;
    word-break: break-all;
}

.clickable {
    cursor: pointer;
}

.error-text {
    color: #ff4d4f;
}
</style>
