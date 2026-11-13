const Protocol = require('../public/js/core/browser-protocol');

const messages = Object.freeze({
    BROWSER_IN_USE: '另一个对话正在使用浏览器，本轮已停止争用，请返回原任务查看进度',
    EXTENSION_OFFLINE: 'Strata 浏览器扩展尚未连接，请打开已安装扩展的 Chrome',
    EXTENSION_NOT_CONNECTED: 'Strata 浏览器扩展尚未连接，请打开已安装扩展的 Chrome',
    EXTENSION_DISCONNECTED: 'Strata 浏览器扩展连接已断开，请检查扩展连接',
    EXTENSION_TIMEOUT: 'Chrome 操作超时，请重新读取页面',
    CHROME_TIMEOUT: 'Chrome 页面操作超时，请重新读取当前任务页面',
    TIMEOUT: '浏览器操作超时，请重新读取页面',
    SHARING_REQUIRED: '浏览器任务已结束，请重新连接',
    SESSION_ENDED: 'Chrome 浏览器任务已结束，请重新连接',
    BROWSER_SESSION_LOST:
        '原浏览器任务已中断，本轮已停止继续操作；已执行的动作可能已经生效，请核实后再开始新任务',
    SESSION_BUSY: 'Chrome 已有正在进行的浏览器任务，请稍后重试',
    BROWSER_BUSY: '浏览器正在执行其他操作，请稍后重试',
    CONNECTING: '浏览器正在连接或清理，请稍后重试',
    STALE_REF: '页面元素已变化，请重新读取页面并使用新的元素引用',
    STALE_REFERENCE: '页面元素已变化，请重新读取页面并使用新的元素引用',
    INVALID_SCROLL:
        '滚动参数无效：pixels 必须是 -5000 到 5000 之间的数字，向下为正、向上为负；horizontal 可省略，填写时也必须是该范围内的数字',
    TAB_NOT_OWNED:
        '目标标签页不属于当前浏览器任务，请调用 browser_tabs 获取任务标签页；操作当前页时可省略 tab_id',
    PAGE_UNAVAILABLE: '当前页面暂不可用，请等待加载完成后重新读取页面',
    TARGET_REQUIRED: '缺少目标元素，请重新读取页面并提供元素 ref',
    TARGET_MISSING: '未找到目标元素，请重新读取页面并使用新的元素引用',
    AMBIGUOUS_TARGET: '找到多个目标元素，请重新读取页面并使用唯一的元素 ref',
    TARGET_DISABLED: '目标元素当前不可操作，请检查页面状态',
    TARGET_BLOCKED: '目标被遮挡或不在可点击区域，本次未点击，请处理遮挡后重新读取页面',
    TARGET_UNSTABLE: '目标位置仍在变化，本次未点击，请等待页面稳定',
    INVALID_WAIT:
        '等待条件无效：wait_for 必须只指定一个 ref、selector、text 或 url_contains，timeout_ms 为 0 到 10000 的整数',
    FOCUS_CHANGED: '输入框或焦点已变化，本次未输入文字，请重新读取页面并选择输入框',
    TASK_TAB_CREATE_FAILED: '无法创建 Chrome 任务标签页，请打开普通 Chrome 窗口后重试',
    TASK_WINDOW_UNAVAILABLE: '无法恢复 Chrome 任务窗口，本次未执行页面操作，请检查 Chrome 窗口',
    INVALID_SELECTOR: '目标选择器无效，请重新读取页面并使用元素 ref',
    NOT_EDITABLE: '目标元素无法输入，请重新读取页面并选择输入框',
    INVALID_KEY: '按键参数无效，请使用支持的按键，例如 Enter、Escape 或 Control+A',
    INVALID_TEXT: '输入文字格式无效或超过长度限制，请检查输入参数',
    INVALID_OBSERVATION:
        '观察参数无效：query 为 1 到 200 个字符，max_elements 为 1 到 160 的整数，max_text_chars 为 256 到 14000 的整数',
    INVALID_URL: '网址无效，请使用完整的 HTTP 或 HTTPS 网址',
    CHROME_ERROR: 'Chrome 未能完成当前操作，请重新读取任务页面；若仍失败，请检查任务标签页和扩展连接',
    UNAUTHORIZED: '浏览器桥接认证失败，请检查服务配置'
});

function safeBrowserCode(value) {
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'BROWSER_ERROR';
}

function browserErrorMessage(code) {
    return messages[code] || `浏览器操作失败（${code}），请重新读取页面或检查扩展连接`;
}

function parameterType(value) {
    return value === undefined
        ? 'missing'
        : value === null
          ? 'null'
          : Array.isArray(value)
            ? 'array'
            : typeof value;
}

function reportBrowserToolFailure({ name, code, status, startedAt, params }, write = console.warn) {
    const record = {
        event: 'browser_tool_failed',
        timestamp: new Date().toISOString(),
        tool: Object.hasOwn(Protocol.labels, name) ? name : 'unknown',
        code: safeBrowserCode(code),
        status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
        elapsed_ms: Math.max(0, Date.now() - startedAt)
    };
    // Record only fixed diagnostic fields, never URLs, page text, typed values, or credentials.
    if (name === 'browser_scroll') {
        record.scroll = {};
        for (const key of ['pixels', 'horizontal']) {
            const value = params?.[key];
            record.scroll[key] = {
                type: parameterType(value),
                ...(typeof value === 'number' && Number.isFinite(value) ? { value } : {})
            };
        }
        record.scroll.tab_id_type = parameterType(params?.tab_id);
    }
    write('[browser-tool] ' + JSON.stringify(record));
}

module.exports = { safeBrowserCode, browserErrorMessage, reportBrowserToolFailure };
