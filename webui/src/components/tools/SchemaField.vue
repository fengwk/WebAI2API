<script setup>
import { computed } from 'vue';
import { message } from 'ant-design-vue';
import { InboxOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons-vue';

const props = defineProps({
    schema: {
        type: Object,
        required: true
    },
    modelValue: {
        type: null,
        default: undefined
    },
    fieldKey: {
        type: String,
        default: ''
    },
    level: {
        type: Number,
        default: 0
    }
});

const emit = defineEmits(['update:modelValue']);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function isSingleFileSchema(schema) {
    return schema?.['x-ui'] === 'file' || isFileObjectSchema(schema);
}

function isMultiFileSchema(schema) {
    return schema?.['x-ui'] === 'files' || (inferSchemaType(schema) === 'array' && isFileObjectSchema(schema.items));
}

function buildDefaultValue(schema) {
    if (schema?.default !== undefined) {
        return JSON.parse(JSON.stringify(schema.default));
    }
    if (schema?.enum?.length) {
        return schema.enum[0];
    }

    const schemaType = inferSchemaType(schema);
    if (isSingleFileSchema(schema)) return null;
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

function cloneValue(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function updateValue(value) {
    emit('update:modelValue', value);
}

const schemaType = computed(() => inferSchemaType(props.schema));
const fieldLabel = computed(() => props.schema.title || props.fieldKey || '字段');
const currentValue = computed(() => {
    if (props.modelValue !== undefined) {
        return props.modelValue;
    }
    return buildDefaultValue(props.schema);
});

const fileAccept = computed(() => props.schema['x-accept'] || '*/*');
const isTextarea = computed(() => props.schema['x-ui'] === 'textarea' || (schemaType.value === 'string' && (props.schema.maxLength || 0) > 120));

function setObjectField(key, value) {
    const next = isPlainObject(currentValue.value) ? cloneValue(currentValue.value) : {};
    next[key] = value;
    updateValue(next);
}

function addArrayItem() {
    const next = Array.isArray(currentValue.value) ? cloneValue(currentValue.value) : [];
    next.push(buildDefaultValue(props.schema.items || {}));
    updateValue(next);
}

function updateArrayItem(index, value) {
    const next = Array.isArray(currentValue.value) ? cloneValue(currentValue.value) : [];
    next[index] = value;
    updateValue(next);
}

function removeArrayItem(index) {
    const next = Array.isArray(currentValue.value) ? cloneValue(currentValue.value) : [];
    next.splice(index, 1);
    updateValue(next);
}

function fileToPayload(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const base64 = result.includes(',') ? result.split(',')[1] : result;
            resolve({
                fileName: file.name,
                mimeType: file.type || 'application/octet-stream',
                base64
            });
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function handleSingleFile(file) {
    try {
        updateValue(await fileToPayload(file));
    } catch (e) {
        message.error(`文件读取失败: ${e.message}`);
    }
    return false;
}

async function handleMultiFile(file) {
    try {
        const payload = await fileToPayload(file);
        const next = Array.isArray(currentValue.value) ? cloneValue(currentValue.value) : [];
        next.push(payload);
        updateValue(next);
    } catch (e) {
        message.error(`文件读取失败: ${e.message}`);
    }
    return false;
}

function removeSingleFile() {
    updateValue(null);
}

function removeMultiFile(index) {
    const next = Array.isArray(currentValue.value) ? cloneValue(currentValue.value) : [];
    next.splice(index, 1);
    updateValue(next);
}
</script>

<template>
    <div class="schema-field" :style="{ marginLeft: level > 0 ? `${level * 16}px` : '0' }">
        <template v-if="isSingleFileSchema(schema)">
            <div class="schema-label">{{ fieldLabel }}</div>
            <a-upload-dragger :file-list="[]" :before-upload="handleSingleFile" :show-upload-list="false" :accept="fileAccept">
                <p style="margin: 0;"><InboxOutlined style="font-size: 20px; color: #1890ff;" /></p>
                <p class="schema-help">点击或拖拽上传文件</p>
            </a-upload-dragger>
            <div v-if="currentValue" class="schema-tags">
                <a-tag closable @close.prevent="removeSingleFile">{{ currentValue.fileName }}</a-tag>
            </div>
        </template>

        <template v-else-if="isMultiFileSchema(schema)">
            <div class="schema-label">{{ fieldLabel }}</div>
            <a-upload-dragger :file-list="[]" :before-upload="handleMultiFile" :show-upload-list="false" :accept="fileAccept" multiple>
                <p style="margin: 0;"><InboxOutlined style="font-size: 20px; color: #1890ff;" /></p>
                <p class="schema-help">点击或拖拽上传多个文件</p>
            </a-upload-dragger>
            <div v-if="(currentValue || []).length > 0" class="schema-tags">
                <a-tag v-for="(item, index) in currentValue" :key="`${item.fileName}-${index}`" closable @close.prevent="removeMultiFile(index)">
                    {{ item.fileName }}
                </a-tag>
            </div>
        </template>

        <template v-else-if="schemaType === 'object'">
            <div v-if="level > 0" class="schema-group-title">{{ fieldLabel }}</div>
            <SchemaField
                v-for="(childSchema, key) in schema.properties || {}"
                :key="key"
                :schema="childSchema"
                :field-key="key"
                :model-value="(currentValue || {})[key]"
                :level="level + 1"
                @update:model-value="value => setObjectField(key, value)"
            />
        </template>

        <template v-else-if="schemaType === 'array'">
            <div class="schema-group-title">{{ fieldLabel }}</div>
            <div class="schema-array-actions">
                <a-button size="small" @click="addArrayItem">
                    <template #icon><PlusOutlined /></template>
                    添加项
                </a-button>
            </div>
            <div v-for="(item, index) in currentValue || []" :key="index" class="schema-array-item">
                <SchemaField
                    :schema="schema.items || {}"
                    :field-key="`${fieldLabel}[${index}]`"
                    :model-value="item"
                    :level="level + 1"
                    @update:model-value="value => updateArrayItem(index, value)"
                />
                <a-button size="small" danger @click="removeArrayItem(index)">
                    <template #icon><DeleteOutlined /></template>
                </a-button>
            </div>
        </template>

        <template v-else-if="schema.enum">
            <div class="schema-label">{{ fieldLabel }}</div>
            <a-select :value="currentValue" style="width: 100%" @update:value="updateValue">
                <a-select-option v-for="item in schema.enum" :key="String(item)" :value="item">
                    {{ item }}
                </a-select-option>
            </a-select>
        </template>

        <template v-else-if="schemaType === 'boolean'">
            <div class="schema-label">{{ fieldLabel }}</div>
            <a-switch :checked="!!currentValue" @update:checked="updateValue" />
        </template>

        <template v-else-if="schemaType === 'number' || schemaType === 'integer'">
            <div class="schema-label">{{ fieldLabel }}</div>
            <a-input-number
                :value="currentValue"
                style="width: 100%"
                :step="schemaType === 'integer' ? 1 : 0.1"
                @update:value="updateValue"
            />
        </template>

        <template v-else>
            <div class="schema-label">{{ fieldLabel }}</div>
            <a-textarea v-if="isTextarea" :value="currentValue" :rows="4" @update:value="updateValue" />
            <a-input v-else :value="currentValue" @update:value="updateValue" />
        </template>

        <div v-if="schema.description" class="schema-help">{{ schema.description }}</div>
    </div>
</template>

<style scoped>
.schema-field {
    margin-bottom: 16px;
}

.schema-label,
.schema-group-title {
    font-weight: 600;
    margin-bottom: 6px;
}

.schema-help {
    font-size: 12px;
    color: #8c8c8c;
    margin-top: 6px;
}

.schema-tags {
    margin-top: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.schema-array-actions {
    margin-bottom: 8px;
}

.schema-array-item {
    border: 1px solid #f0f0f0;
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 8px;
    background: #fafafa;
}
</style>
