<script setup>
import { onMounted, reactive } from 'vue';
import { useSettingsStore } from '@/stores/settings';

const settingsStore = useSettingsStore();

// 表单数据
const formData = reactive({
    port: 3000,
    logLevel: 'info',
    queueBuffer: 2,
    publicFileBaseUrl: '',
    publicApiBaseUrl: ''
});

onMounted(async () => {
    await settingsStore.fetchServerConfig();
    Object.assign(formData, settingsStore.serverConfig);
});

// 实际保存逻辑
const doSave = async () => {
    await settingsStore.saveServerConfig(formData);
};

// 保存设置
const handleSave = async () => {
    await doSave();
};
</script>

<template>
    <a-layout style="background: transparent;">
        <a-card title="服务器设置" :bordered="false" style="width: 100%;">
            <!-- 4宫格表单布局 -->
            <a-row :gutter="[16, 16]">
                <!-- 监听端口 -->
                <a-col :xs="24" :md="12">
                    <div style="margin-bottom: 8px;">
                        <div style="font-weight: 600; margin-bottom: 4px;">监听端口</div>
                        <div style="font-size: 12px; color: #8c8c8c; margin-bottom: 8px;">
                            设置服务器监听的端口号，默认为 3000
                        </div>
                        <a-input-number v-model:value="formData.port" :min="1" :max="65535" placeholder="请输入端口号"
                            style="width: 100%" />
                    </div>
                </a-col>

                <!-- 日志等级 -->
                <a-col :xs="24" :md="12">
                    <div style="margin-bottom: 8px;">
                        <div style="font-weight: 600; margin-bottom: 4px;">日志等级</div>
                        <div style="font-size: 12px; color: #8c8c8c; margin-bottom: 8px;">
                            设置服务器日志输出的详细程度
                        </div>
                        <a-select v-model:value="formData.logLevel" style="width: 100%" placeholder="请选择日志等级">
                            <a-select-option value="debug">Debug - 调试日志</a-select-option>
                            <a-select-option value="info">Info - 普通信息</a-select-option>
                            <a-select-option value="warn">Warn - 警告信息</a-select-option>
                            <a-select-option value="error">Error - 仅错误</a-select-option>
                        </a-select>
                    </div>
                </a-col>

                <!-- 外部文件访问基准 URL -->
                <a-col :xs="24" :md="12">
                    <div style="margin-bottom: 8px;">
                        <div style="font-weight: 600; margin-bottom: 4px;">文件 URL 基准地址</div>
                        <div style="font-size: 12px; color: #8c8c8c; margin-bottom: 8px;">
                            当脚本通过 helper 返回 URL 文件时，用它拼接外部可访问地址。<br>
                            例如: https://gpt-load.kk1.fun/proxy/gpt-image
                        </div>
                        <a-input v-model:value="formData.publicFileBaseUrl" placeholder="留空则返回 /files/... 相对路径" />
                    </div>
                </a-col>

                <a-col :xs="24" :md="12">
                    <div style="margin-bottom: 8px;">
                        <div style="font-weight: 600; margin-bottom: 4px;">API 基准地址</div>
                        <div style="font-size: 12px; color: #8c8c8c; margin-bottom: 8px;">
                            WebUI 里 curl 示例使用的外部 API 前缀。<br>
                            例如: https://webai2api.kk1.fun
                        </div>
                        <a-input v-model:value="formData.publicApiBaseUrl" placeholder="留空则使用当前页面的 http:// 或 https:// 前缀" />
                    </div>
                </a-col>
            </a-row>

            <!-- 保存按钮（右下角） -->
            <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
                <a-button type="primary" @click="handleSave">
                    保存设置
                </a-button>
            </div>
        </a-card>

        <!-- 队列设置 -->
        <a-card title="队列设置" :bordered="false" style="width: 100%; margin-top: 10px;">
            <a-row :gutter="[16, 16]">
                <!-- 队列缓冲区大小 -->
                <a-col :xs="24" :md="12">
                    <div style="margin-bottom: 8px;">
                        <div style="font-weight: 600; margin-bottom: 4px;">队列缓冲区大小</div>
                        <div style="font-size: 12px; color: #8c8c8c; margin-bottom: 8px;">
                            非流式请求的额外排队数（设为 0 则不限制非流式请求数量）<br>
                            实际队列上限 = Workers数量 + 缓冲区大小
                        </div>
                        <a-input-number v-model:value="formData.queueBuffer" :min="0" :max="100" placeholder="默认为 2"
                            style="width: 100%" />
                    </div>
                </a-col>

            </a-row>

            <!-- 保存按钮（右下角） -->
            <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
                <a-button type="primary" @click="handleSave">
                    保存设置
                </a-button>
            </div>
        </a-card>
    </a-layout>
</template>

<style scoped>
/* 确保在手机端也能正常显示 */
.ant-input-number {
    width: 100%;
}
</style>
