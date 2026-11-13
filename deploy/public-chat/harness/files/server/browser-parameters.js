// Keep the model-facing wait contract explicit, including with an older bridge.
function withWaitContract(definition) {
    const fn = definition.function;
    const wait = fn?.parameters?.properties?.wait_for;
    if (!wait) return definition;
    return { ...definition, function: { ...fn, parameters: { ...fn.parameters,
        properties: { ...fn.parameters.properties, wait_for: { ...wait,
            description: wait.description + ' Omit wait_for for normal navigation. A timeout alone is not a condition.',
            oneOf: ['ref', 'selector', 'text', 'url_contains'].map(key => ({ required: [key] }))
        } }
    } } };
}

function navigationParameters(name, params) {
    const wait = params?.wait_for;
    // This compatibility case has no condition to lose. Do not apply it to
    // clicks, typing, submits, empty/invalid values, or any specified condition.
    if (name !== 'browser_navigate' || !wait || typeof wait !== 'object' || Array.isArray(wait) ||
        Object.keys(wait).length !== 1 || !Object.hasOwn(wait, 'timeout_ms') ||
        !Number.isInteger(wait.timeout_ms) || wait.timeout_ms < 0 || wait.timeout_ms > 10000)
        return { params };
    const { wait_for, ...normalized } = params;
    return { params: normalized, adjustment: {
        code: 'NAVIGATION_TIMEOUT_WITHOUT_CONDITION',
        requested_timeout_ms: wait_for.timeout_ms,
        applied: 'default_navigation_readiness',
        notice: 'wait_for 仅含超时、没有页面条件，已使用导航默认加载等待；未应用该超时，也未确认任何业务条件。请依据返回页面判断下一步。'
    } };
}

// Validate the live tool definition before dispatch. Never echo private argument values.
function argumentProblem(value, schema, path = '参数') {
    if (!schema) return null;
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (schema.type === 'integer' ? !Number.isInteger(value) : schema.type && schema.type !== actual)
        return path + ' 需要 ' + schema.type;
    if (schema.enum && !schema.enum.includes(value)) return path + ' 不在允许的取值范围';
    if (typeof value === 'number' && (value < schema.minimum || value > schema.maximum)) return path + ' 超出范围';
    if (typeof value === 'string' && (value.length < schema.minLength || value.length > schema.maxLength)) return path + ' 长度无效';
    if (actual === 'object') {
        for (const key of schema.required || []) if (!Object.hasOwn(value, key)) return path + ' 缺少 ' + key;
        for (const [key, child] of Object.entries(value)) {
            const declared = Object.hasOwn(schema.properties || {}, key);
            if (!declared && schema.additionalProperties === false) return path + ' 含未声明字段';
            if (declared) {
                const problem = argumentProblem(child, schema.properties[key], path + '.' + key);
                if (problem) return problem;
            }
        }
        if (schema.oneOf && schema.oneOf.filter(rule => rule.required?.every(k => Object.hasOwn(value, k))).length !== 1)
            return path + ' 需要恰好一个匹配条件';
    }
    return null;
}

module.exports = { withWaitContract, navigationParameters, argumentProblem };
