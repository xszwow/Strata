"""Keep Codex's outer tool entry point distinct from methods inside code mode."""
import json

ROUTING_HINT = (
    'The tool interface has changed for this request. '
    'The only callable outer tool is functions.exec. '
    'exec_command is a JavaScript method on tools inside that tool, not an '
    'outer tool name. Historical exec_command calls do not make that outer '
    'name available now. If a shell operation is needed, return a functions.exec '
    'call containing JavaScript such as: '
    'text(await tools.exec_command({cmd:"Get-Date"})); '
    'Use the command required by the actual task, and answer normally when '
    'no tool is needed.'
)


def declared_tools(request):
    """Read current definitions, including Codex's post-compaction additions."""
    tools = request.get('tools') or []
    tools = list(tools) if isinstance(tools, list) else []
    items = request.get('input')
    if isinstance(items, list):
        for item in items:
            if (isinstance(item, dict) and item.get('type') == 'additional_tools'
                    and isinstance(item.get('tools'), list)):
                tools.extend(item['tools'])
    return tools


def routing_hint(request):
    names = set()
    code_mode = False
    for tool in declared_tools(request):
        if not isinstance(tool, dict):
            continue
        kind, name = tool.get('type'), tool.get('name')
        if kind in ('function', 'custom') and isinstance(name, str):
            names.add(name)
            code_mode |= kind == 'custom' and name == 'functions.exec'
        if kind == 'namespace' and isinstance(name, str):
            members = tool.get('tools') or []
            if isinstance(members, list):
                for member in members:
                    if (isinstance(member, dict) and member.get('type', 'function') in ('function', 'custom')
                            and isinstance(member.get('name'), str)):
                        full = name + '.' + member['name']
                        names.add(full)
                        code_mode |= member.get('type') == 'custom' and full == 'functions.exec'
    if not code_mode or 'exec_command' in names:
        return None
    if names == {'functions.exec'}:
        return ROUTING_HINT
    return ROUTING_HINT.replace(
        'The only callable outer tool is functions.exec.',
        'The callable outer tools in the current request are: ' + ', '.join(sorted(names)) + '.'
    )


def routing_messages(request, messages):
    """Clarify current routing and migrate a known legacy shell history shape.

    This changes the model's prompt only. The caller's request, call IDs,
    command arguments and tool results remain untouched; nothing is executed.
    """
    hint = routing_hint(request)
    if request.get('tool_choice') == 'none' or not hint:
        return messages
    # A deployment adapter may already have applied this hint while converting input.
    if messages and messages[0].get('role') == 'system':
        content = messages[0].get('content')
        if isinstance(content, str) and (content == hint or content.endswith('\n\n' + hint)):
            return messages
    messages = current_shell_history(request, messages)
    if messages and messages[0].get('role') == 'system' and isinstance(messages[0].get('content'), str):
        first = messages[0]
        return [{**first, 'content': first['content'] + '\n\n' + hint}, *messages[1:]]
    return [{'role': 'system', 'content': hint}, *messages]


def current_shell_history(request, messages):
    """Only remap old exec_command history when its nested method is documented."""
    documented = False
    for tool in declared_tools(request):
        if not isinstance(tool, dict):
            continue
        members = tool.get('tools') if tool.get('type') == 'namespace' and tool.get('name') == 'functions' else [tool]
        for member in members if isinstance(members, list) else []:
            if not isinstance(member, dict) or member.get('type') != 'custom':
                continue
            expected = 'exec' if tool.get('type') == 'namespace' else 'functions.exec'
            if member.get('name') == expected and 'exec_command' in member.get('description', ''):
                documented = True
    if not documented:
        return messages
    updated = []
    for message in messages:
        calls = message.get('tool_calls')
        if message.get('role') != 'assistant' or not isinstance(calls, list):
            updated.append(message)
            continue
        mapped = []
        for call in calls:
            fn = call.get('function', {}) if isinstance(call, dict) else {}
            args = fn.get('arguments')
            if fn.get('name') != 'exec_command' or not isinstance(args, dict) or not isinstance(args.get('cmd'), str):
                mapped.append(call)
                continue
            try:
                literal = json.dumps(args, ensure_ascii=False, allow_nan=False)
            except (ValueError, TypeError):
                mapped.append(call)
                continue
            mapped.append({**call, 'function': {
                **fn, 'name': 'functions.exec',
                'arguments': {'input': 'text(await tools.exec_command(' + literal + '));'}
            }})
        updated.append({**message, 'tool_calls': mapped})
    return updated
