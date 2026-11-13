const { HttpError } = require('./errors');
const { argumentProblem } = require('./browser-parameters');

const statuses = ['pending', 'in_progress', 'waiting', 'completed'];
const fields = {
    id: { type: 'string', minLength: 1, maxLength: 48, description: '稳定的短标识，更新时沿用' },
    title: { type: 'string', minLength: 1, maxLength: 120, description: '具体对象与目标' },
    status: { type: 'string', enum: statuses },
    note: { type: 'string', maxLength: 320, description: '保留已知条件、有效方法、已核实结果或下一步；不复制报错或整页内容' }
};
const itemSchema = { type: 'object', properties: fields, required: ['id', 'title', 'status'], additionalProperties: false };
const updateSchema = { ...itemSchema, required: ['id', 'status'], properties: {
    ...fields, status: { type: 'string', enum: [...statuses, 'removed'] }
} };
const definition = { type: 'function', function: {
    name: 'task_update', description: '维护当前会话待办。一批可新增或更新多个事项，未列出的事项保留。新增需 title，删除用 removed。',
    parameters: { type: 'object', additionalProperties: false, required: ['items'], properties: {
        items: { type: 'array', minItems: 1, maxItems: 32, items: updateSchema }
    } }
} };
const guidance = '对要分步执行、跨轮跟进或明确要求记录的任务，用 task_update 保存具体目标、约束和下一步，关键进展及时更新。简单问答直接答。待办是工作记录，服从用户当前要求；标记完成应有实际结果，结果不明时标 waiting 并记下核验步骤。只为当前请求行动，不自动执行其他待办。';

function invalid(message) {
    return Object.assign(new HttpError(400, message), { code: 'INVALID_TOOL_ARGUMENTS' });
}
function validateItems(items, schema, minimum) {
    if (!Array.isArray(items) || items.length < minimum || items.length > 32)
        throw invalid('待办清单最多 32 项，更新至少需要一项');
    const ids = new Set();
    for (const item of items) {
        const problem = argumentProblem(item, schema);
        if (problem) throw invalid(problem);
        if (!item.id.trim() || ids.has(item.id) || (item.title !== undefined && !item.title.trim()))
            throw invalid('待办标识须非空且本批唯一，标题须包含文字');
        ids.add(item.id);
    }
    return items;
}
function validateTasks(items) { return validateItems(items, itemSchema, 0); }
function updateTasks(previous, changes) {
    const tasks = new Map(previous.map(item => [item.id, item]));
    for (const change of validateItems(changes, updateSchema, 1)) {
        if (change.status === 'removed') { tasks.delete(change.id); continue; }
        const item = { ...tasks.get(change.id), ...change };
        if (!item.title) throw invalid('新增事项需要 title；更新已有事项请沿用原 id');
        tasks.set(item.id, item);
    }
    return validateTasks([...tasks.values()]);
}
module.exports = { definition, guidance, validateTasks, updateTasks };
