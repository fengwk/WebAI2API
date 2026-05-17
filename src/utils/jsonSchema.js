function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeOfValue(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (Number.isInteger(value)) return 'integer';
    return typeof value;
}

function validateFormat(format, value) {
    if (format === 'uri') {
        try {
            const url = new URL(String(value));
            return ['http:', 'https:', 'data:'].includes(url.protocol);
        } catch {
            return false;
        }
    }
    return true;
}

export function validateSchemaDefinition(schema, path = '$') {
    const errors = [];

    if (!isPlainObject(schema)) {
        return [`${path} 必须是对象`];
    }

    if (schema.oneOf !== undefined) {
        if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
            errors.push(`${path}.oneOf 必须是非空数组`);
        } else {
            schema.oneOf.forEach((item, index) => {
                errors.push(...validateSchemaDefinition(item, `${path}.oneOf[${index}]`));
            });
        }
        return errors;
    }

    const allowedTypes = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
    if (schema.type !== undefined && !allowedTypes.includes(schema.type)) {
        errors.push(`${path}.type 不受支持: ${schema.type}`);
    }

    if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
        errors.push(`${path}.enum 必须是数组`);
    }

    if (schema.required !== undefined && !Array.isArray(schema.required)) {
        errors.push(`${path}.required 必须是数组`);
    }

    if (schema.properties !== undefined) {
        if (!isPlainObject(schema.properties)) {
            errors.push(`${path}.properties 必须是对象`);
        } else {
            for (const [key, value] of Object.entries(schema.properties)) {
                errors.push(...validateSchemaDefinition(value, `${path}.properties.${key}`));
            }
        }
    }

    if (schema.items !== undefined) {
        errors.push(...validateSchemaDefinition(schema.items, `${path}.items`));
    }

    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true && schema.additionalProperties !== false) {
        errors.push(...validateSchemaDefinition(schema.additionalProperties, `${path}.additionalProperties`));
    }

    return errors;
}

export function validateJsonSchema(schema, value, path = '$') {
    const errors = [];

    if (!isPlainObject(schema)) {
        return [`${path} 的 schema 无效`];
    }

    if (schema.oneOf) {
        const candidates = schema.oneOf.map(item => validateJsonSchema(item, value, path));
        if (!candidates.some(candidate => candidate.length === 0)) {
            errors.push(`${path} 不匹配任何 oneOf 选项`);
        }
        return errors;
    }

    if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) {
        errors.push(`${path} 必须是枚举值之一`);
        return errors;
    }

    if (schema.type) {
        const actualType = typeOfValue(value);
        const typeMatched = schema.type === actualType || (schema.type === 'number' && actualType === 'integer');
        if (!typeMatched) {
            errors.push(`${path} 类型错误，期望 ${schema.type}，实际 ${actualType}`);
            return errors;
        }
    }

    if (schema.type === 'string') {
        if (schema.minLength !== undefined && String(value).length < schema.minLength) {
            errors.push(`${path} 长度不能小于 ${schema.minLength}`);
        }
        if (schema.format && !validateFormat(schema.format, value)) {
            errors.push(`${path} 必须是合法的 ${schema.format}`);
        }
        return errors;
    }

    if (schema.type === 'number' || schema.type === 'integer') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            errors.push(`${path} 不能小于 ${schema.minimum}`);
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            errors.push(`${path} 不能大于 ${schema.maximum}`);
        }
        return errors;
    }

    if (schema.type === 'array') {
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            errors.push(`${path} 数组长度不能小于 ${schema.minItems}`);
        }
        if (schema.maxItems !== undefined && value.length > schema.maxItems) {
            errors.push(`${path} 数组长度不能大于 ${schema.maxItems}`);
        }
        if (schema.items) {
            value.forEach((item, index) => {
                errors.push(...validateJsonSchema(schema.items, item, `${path}[${index}]`));
            });
        }
        return errors;
    }

    if (schema.type === 'object') {
        const properties = schema.properties || {};
        const required = schema.required || [];
        for (const key of required) {
            if (value[key] === undefined) {
                errors.push(`${path}.${key} 是必填字段`);
            }
        }

        for (const [key, propertySchema] of Object.entries(properties)) {
            if (value[key] !== undefined) {
                errors.push(...validateJsonSchema(propertySchema, value[key], `${path}.${key}`));
            }
        }

        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!(key in properties)) {
                    errors.push(`${path}.${key} 不是允许的字段`);
                }
            }
        } else if (isPlainObject(schema.additionalProperties)) {
            for (const [key, item] of Object.entries(value)) {
                if (!(key in properties)) {
                    errors.push(...validateJsonSchema(schema.additionalProperties, item, `${path}.${key}`));
                }
            }
        }
    }

    return errors;
}

export function stringifyJson(value) {
    return JSON.stringify(value, null, 2);
}
