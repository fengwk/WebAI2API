<script setup>
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import { message, Modal } from 'ant-design-vue';
import {
    ReloadOutlined,
    DeleteOutlined,
    EyeOutlined,
    RocketOutlined,
    CopyOutlined,
    RedoOutlined,
    DownloadOutlined
} from '@ant-design/icons-vue';

const settingsStore = useSettingsStore();

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

// 新请求协议字段
const inputText = ref('{}');
const debugFlag = ref(false);
const workerIdText = ref('');
const overrideScriptText = ref('');
const sending = ref(false);
const latestResponse = ref(null);
const latestError = ref('');
const autoRefreshEnabled = ref(true);

let autoRefreshInterval = null;
let searchTimeout = null;

function tryParseInput() {
    const raw = String(inputText.value || '').trim() || '{}';
    try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            throw new Error('input 必须是 JSON 对象');
        }
        return { ok: true, value: obj };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

const adapters = computed(() => settingsStore.adaptersMeta.filter(item => item.valid !== false));
const adapterOptions = computed(() => adapters.value.map(item => ({ label: item.name || item.id, value: item.id })));
const selectedAdapter = computed(() => adapters.value.find(item => item.id === selectedAdapterId.value) || null);
const adapterEndpoint = computed(() => selectedAdapter.value?.endpoint || (selectedAdapter.value ? `/api/${selectedAdapter.value.id}` : ''));
const curlBaseUrl = computed(() => {
    const configured = String(settingsStore.serverConfig?.publicApiBaseUrl || '').trim();
    return configured || window.location.origin;
});

const parsedInput = computed(() => tryParseInput());
const inputJsonError = computed(() => parsedInput.value.ok ? '' : parsedInput.value.error);

function buildRequestPayload() {
    const parsed = tryParseInput();
    if (!parsed.ok) {
        throw new Error(`input JSON 解析失败: ${parsed.error}`);
    }
    const payload = { input: parsed.value };
    if (debugFlag.value) payload.debug = true;
    const workerId = String(workerIdText.value || '').trim();
    if (workerId) payload.workerId = workerId;
    const overrideScript = String(overrideScriptText.value || '');
    if (overrideScript.trim()) payload.overrideScript = overrideScript;
    return payload;
}

function buildCurlCommand() {
    if (!selectedAdapter.value) return '';
    let body;
    try { body = buildRequestPayload(); }
    catch { body = { input: {} }; }
    const url = `${curlBaseUrl.value}${adapterEndpoint.value}`;
    const json = JSON.stringify(body, null, 2);
    const escapedJson = json.replace(/'/g, `'"'"'`);
    return [
        `curl -X POST "${url}" \\`,
        '  -H "Content-Type: application/json" \\',
        `  -d '${escapedJson}'`
    ].filter(Boolean).join('\n');
}

const historyColumns = [
    { title: '状态', dataIndex: 'status', key: 'status', width: 80, align: 'center' },
    { title: '接口', dataIndex: 'adapter_id', key: 'adapter_id', width: 150 },
    { title: '请求', dataIndex: 'request_summary', key: 'request_summary', width: 260 },
    { title: '响应', dataIndex: 'response_summary', key: 'response_summary', width: 320 },
    { title: '时间', dataIndex: 'created_at', key: 'created_at', width: 140 },
    { title: '耗时', dataIndex: 'duration_ms', key: 'duration_ms', width: 80, align: 'right' },
    { title: '', key: 'action', width: 140, align: 'center', fixed: 'right' }
];

function formatTime(timestamp) {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
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

function resetRequestForm() {
    inputText.value = '{}';
    debugFlag.value = false;
    workerIdText.value = '';
    overrideScriptText.value = '';
    latestResponse.value = null;
    latestError.value = '';
}

watch(selectedAdapterId, () => {
    resetRequestForm();
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

async function fetchHistoryDetailById(id) {
    const res = await fetch(`/admin/history/${id}`, { headers: settingsStore.getHeaders() });
    if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error?.message || payload.message || `获取详情失败: HTTP ${res.status}`);
    }
    return await res.json();
}

async function fetchAdapters() {
    await settingsStore.fetchAdaptersMeta();
    if (!selectedAdapterId.value && adapters.value.length > 0) {
        selectedAdapterId.value = adapters.value[0].id;
    }
}

async function fetchHistory() {
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
    }
}

function startAutoRefresh() {
    if (autoRefreshInterval) return;
    autoRefreshInterval = setInterval(() => {
        if (autoRefreshEnabled.value) fetchHistory();
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
    let payload;
    try { payload = buildRequestPayload(); }
    catch (e) { message.error(e.message); return; }

    sending.value = true;
    latestResponse.value = null;
    latestError.value = '';
    try {
        const res = await fetch(adapterEndpoint.value, {
            method: 'POST',
            headers: settingsStore.getHeaders(),
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            latestError.value = data.error?.message || data.message || `HTTP ${res.status}`;
            message.error(latestError.value);
        } else {
            latestResponse.value = data;
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
        currentRecord.value = await fetchHistoryDetailById(record.id);
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

async function resendRecord(record) {
    if (!record.adapter_id) {
        message.warning('该记录缺少可重发的请求体');
        return;
    }
    try {
        const detail = record.request_body ? record : await fetchHistoryDetailById(record.id);
        if (!detail.request_body) {
            message.warning('该记录缺少可重发的请求体');
            return;
        }
        selectedAdapterId.value = detail.adapter_id;
        // 重发时尽量还原新协议的 input
        const body = detail.request_body;
        if (body && typeof body === 'object' && 'input' in body) {
            inputText.value = JSON.stringify(body.input, null, 2);
            debugFlag.value = !!body.debug;
            workerIdText.value = body.workerId || '';
            overrideScriptText.value = ''; // overrideScript 不会保存在历史中
        } else {
            // 旧协议：原样回填 input
            inputText.value = JSON.stringify(body, null, 2);
        }
    } catch (e) {
        message.error(`读取重发内容失败: ${e.message}`);
    }
}

async function downloadHistoryBody(record, kind) {
    try {
        const res = await fetch(`/admin/history/${record.id}/${kind}-body`, {
            headers: settingsStore.getHeaders()
        });
        if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            throw new Error(payload.error?.message || payload.message || `下载失败: HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `history-${record.id}-${kind}-body.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    } catch (e) {
        message.error(`下载失败: ${e.message}`);
    }
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
    await Promise.all([fetchAdapters(), fetchHistory(), settingsStore.fetchServerConfig()]);
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
            <a-col :xs="24" :lg="7">
                <div style="margin-bottom: 16px;">
                    <div class="label">适配器</div>
                    <a-select v-model:value="selectedAdapterId" style="width: 100%" :options="adapterOptions" placeholder="选择适配器" />
                </div>
                <div v-if="selectedAdapter" class="meta-box">
                    <div><strong>名称：</strong>{{ selectedAdapter.name }}</div>
                    <div v-if="selectedAdapter.description"><strong>说明：</strong>{{ selectedAdapter.description }}</div>
                    <div v-if="selectedAdapter.homePageUrl"><strong>主页：</strong><code>{{ selectedAdapter.homePageUrl }}</code></div>
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

            <a-col :xs="24" :lg="17">
                <a-alert
                    type="info"
                    show-icon
                    style="margin-bottom: 16px;"
                    message="请求体使用新协议：{ input, debug?, workerId?, overrideScript? }，仅 input 必填。响应统一为 envelope：{ ok, data/message, meta, trace? }。"
                />
                <a-empty v-if="!selectedAdapter" description="请选择有效适配器" />
                <template v-else>
                    <div class="label">input (JSON 对象)</div>
                    <a-textarea
                        v-model:value="inputText"
                        :auto-size="{ minRows: 8, maxRows: 16 }"
                        style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;"
                    />
                    <div v-if="inputJsonError" class="error-text" style="margin-top: 4px;">{{ inputJsonError }}</div>

                    <a-collapse style="margin-top: 12px;">
                        <a-collapse-panel key="advanced" header="高级参数">
                            <a-row :gutter="12">
                                <a-col :xs="24" :md="6">
                                    <div class="label">debug</div>
                                    <a-switch v-model:checked="debugFlag" :checked-children="'true'" :un-checked-children="'false'" />
                                    <span style="margin-left: 8px; color: #8c8c8c; font-size: 12px;">返回 trace</span>
                                </a-col>
                                <a-col :xs="24" :md="9">
                                    <div class="label">workerId（粘性绑定，必须 type === adapterId）</div>
                                    <a-input v-model:value="workerIdText" placeholder="可选：指定 worker" />
                                </a-col>
                                <a-col :xs="24" :md="9">
                                    <div class="label">overrideScript（仅本次覆盖 manifest.script）</div>
                                    <a-textarea
                                        v-model:value="overrideScriptText"
                                        :auto-size="{ minRows: 4, maxRows: 12 }"
                                        placeholder="可选：覆盖脚本"
                                        style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;"
                                    />
                                </a-col>
                            </a-row>
                        </a-collapse-panel>
                    </a-collapse>

                    <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;">
                        <a-button @click="resetRequestForm">重置</a-button>
                        <a-button type="primary" :loading="sending" :disabled="!!inputJsonError" @click="sendRequest">
                            <template #icon><RocketOutlined /></template>
                            调用接口
                        </a-button>
                    </div>
                </template>
            </a-col>
        </a-row>
    </a-card>

    <a-row :gutter="16" style="margin-bottom: 24px;">
        <a-col :xs="24" :lg="12">
            <a-card title="最近响应" :bordered="false">
                <template v-if="latestResponse">
                    <div class="label">Envelope (ok / data / meta / trace?)</div>
                    <pre class="json-box">{{ JSON.stringify(latestResponse, null, 2) }}</pre>
                </template>
                <template v-else-if="latestError">
                    <div class="label">错误</div>
                    <pre class="json-box error-box">{{ latestError }}</pre>
                </template>
                <a-empty v-else description="点击「调用接口」以查看响应" />
            </a-card>
        </a-col>
        <a-col :xs="24" :lg="12">
            <a-card title="使用说明" :bordered="false">
                <ul style="padding-left: 20px; line-height: 1.8;">
                    <li><code>input</code>：业务输入，会透传给 manifest.script 中的 <code>input</code> 变量。</li>
                    <li><code>debug</code>：开启后响应中会包含 <code>trace.steps / captures / logs</code>。</li>
                    <li><code>workerId</code>：粘性调试必须填写；该 worker 的 <code>type</code> 必须等于当前 adapterId。</li>
                    <li><code>overrideScript</code>：仅本次执行覆盖 manifest.script，不修改元信息。</li>
                    <li>所有文件产物（如截图）只返回 URL，不会泄露本地路径。</li>
                </ul>
            </a-card>
        </a-col>
    </a-row>

    <a-card title="最近请求" :bordered="false">
        <template #extra>
            <a-space>
                <a-input v-model:value="searchText" placeholder="搜索请求/响应" allow-clear style="width: 200px" />
                <a-select v-model:value="statusFilter" style="width: 120px" :options="[
                    { label: '全部', value: 'all' },
                    { label: '成功', value: 'success' },
                    { label: '失败', value: 'failed' },
                    { label: '等待中', value: 'pending' }
                ]" />
                <a-input v-model:value="adapterFilter" placeholder="按适配器过滤" allow-clear style="width: 180px" />
                <a-switch v-model:checked="autoRefreshEnabled" checked-children="自动" un-checked-children="手动" />
                <a-button @click="fetchHistory" icon="reload" />
            </a-space>
        </template>

        <a-table
            :columns="historyColumns"
            :data-source="records"
            :pagination="{ current: page, pageSize: pageSize, total: total, showSizeChanger: true }"
            row-key="id"
            @change="handleTableChange"
        >
            <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'status'">
                    <a-tag :color="getStatusColor(record.status)">{{ record.status }}</a-tag>
                </template>
                <template v-else-if="column.key === 'request_summary' || column.key === 'response_summary'">
                    <div
                        class="clickable multiline-text"
                        @click="previewText(
                            column.title,
                            column.key === 'request_summary'
                                ? (record.request_body ? JSON.stringify(record.request_body, null, 2) : (record.request_summary || '-'))
                                : (record.status === 'failed' ? record.error_message : (record.response_body ? JSON.stringify(record.response_body, null, 2) : record.response_summary))
                        )"
                    >
                        {{ truncateText(
                            column.key === 'request_summary'
                                ? record.request_summary
                                : (record.status === 'failed' ? record.error_message : record.response_summary),
                            180
                        ) }}
                    </div>
                </template>
                <template v-else-if="column.key === 'created_at'">{{ formatTime(record.created_at) }}</template>
                <template v-else-if="column.key === 'duration_ms'">{{ formatDuration(record.duration_ms) }}</template>
                <template v-else-if="column.key === 'action'">
                    <a-space :size="0">
                        <a-button type="link" size="small" @click="resendRecord(record)" title="复用参数重发">
                            <template #icon><RedoOutlined /></template>
                        </a-button>
                        <a-button type="link" size="small" @click="viewDetail(record)" title="查看详情">
                            <template #icon><EyeOutlined /></template>
                        </a-button>
                        <a-button type="link" size="small" danger @click="deleteRecord(record)" title="删除">
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
                <a-space style="margin-bottom: 8px;">
                    <a-button size="small" @click="downloadHistoryBody(currentRecord, 'request')">
                        <template #icon><DownloadOutlined /></template>
                        下载完整请求体
                    </a-button>
                </a-space>
                <pre class="json-box">{{ JSON.stringify(currentRecord.request_body, null, 2) }}</pre>

                <a-divider orientation="left">响应</a-divider>
                <a-space v-if="currentRecord.response_body" style="margin-bottom: 8px;">
                    <a-button size="small" @click="downloadHistoryBody(currentRecord, 'response')">
                        <template #icon><DownloadOutlined /></template>
                        下载完整响应体
                    </a-button>
                </a-space>
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
