import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve.codex_tool_routing import ROUTING_HINT, routing_messages
from serve.responses import input_messages


class CodexToolRoutingTests(unittest.TestCase):
    def setUp(self):
        self.wrapper = {'type': 'namespace', 'name': 'functions', 'tools': [
            {'type': 'custom', 'name': 'exec', 'description': 'Run JavaScript', 'format': {'type': 'text'}}]}

    def test_old_tool_history_and_current_declarations_are_preserved(self):
        req = {'tools': [self.wrapper], 'instructions': 'Keep the task instructions.', 'input': [
            {'role': 'user', 'content': 'Check shell version.'},
            {'type': 'function_call', 'call_id': 'old', 'name': 'exec_command', 'arguments': '{"cmd":"Get-Host"}'},
            {'type': 'function_call_output', 'call_id': 'old', 'output': 'PowerShell'},
            {'role': 'user', 'content': 'Now check the date.'}]}
        frozen = copy.deepcopy(req)
        original = input_messages(req)
        messages = routing_messages(req, original)
        self.assertIs(routing_messages(req, messages), messages)
        self.assertEqual(req, frozen)
        self.assertEqual(messages[1:], original[1:])
        self.assertTrue(messages[0]['content'].startswith('Keep the task instructions.'))
        self.assertTrue(messages[0]['content'].endswith(ROUTING_HINT))
        self.assertEqual(original[0]['content'], 'Keep the task instructions.')

    def test_plain_function_api_and_unrelated_exec_tool_are_unchanged(self):
        messages = [{'role': 'user', 'content': 'Inspect date.'}]
        declarations = [[], [{'type': 'function', 'name': 'exec_command'}],
                        [{'type': 'namespace', 'name': 'other', 'tools': self.wrapper['tools']}],
                        [{'type': 'namespace', 'name': 'functions', 'tools': [{'type': 'function', 'name': 'exec'}]}]]
        for tools in declarations:
            with self.subTest(tools=tools):
                self.assertIs(routing_messages({'tools': tools}, messages), messages)

    def test_additional_tools_after_compaction_enable_the_current_route(self):
        req = {'input': [{'type': 'additional_tools', 'tools': [self.wrapper]}]}
        messages = [{'role': 'user', 'content': 'Continue.'}]
        result = routing_messages(req, messages)
        self.assertEqual(result[0], {'role': 'system', 'content': ROUTING_HINT})
        self.assertEqual(result[1:], messages)

    def test_explicit_no_tools_is_respected(self):
        messages = [{'role': 'system', 'content': 'Answer only.'}]
        self.assertIs(routing_messages({'tools': [self.wrapper], 'tool_choice': 'none'}, messages), messages)

    def test_flat_custom_declaration_is_supported(self):
        result = routing_messages({'tools': [{'type': 'custom', 'name': 'functions.exec'}]}, [])
        self.assertEqual(result, [{'role': 'system', 'content': ROUTING_HINT}])

    def test_other_current_outer_tools_remain_available(self):
        request = {'tools': [self.wrapper, {'type': 'function', 'name': 'lookup_weather'}]}
        content = routing_messages(request, [])[0]['content']
        self.assertIn('functions.exec, lookup_weather', content)
        self.assertNotIn('only callable outer tool', content)

    def test_explicitly_declared_direct_shell_is_not_denied(self):
        messages = [{'role': 'user', 'content': 'Inspect.'}]
        request = {'tools': [self.wrapper, {'type': 'function', 'name': 'exec_command'}]}
        self.assertIs(routing_messages(request, messages), messages)

    def test_prompt_history_migration_preserves_command_id_result_and_request(self):
        import json
        wrapper = copy.deepcopy(self.wrapper)
        wrapper['tools'][0]['description'] = 'Run JavaScript. tools.exec_command takes {cmd:string}.'
        request = {'tools': [wrapper]}
        args = {'cmd': 'Write-Output "A\\B"; $x = "枫叶"', 'workdir': 'C:\\tmp'}
        messages = [
            {'role': 'assistant', 'content': '', 'tool_calls': [
                {'function': {'name': 'exec_command', 'arguments': args}, '_call_id': 'old'}]},
            {'role': 'tool', 'content': 'Original result', '_call_id': 'old'}]
        frozen = copy.deepcopy(messages)
        result = routing_messages(request, messages)
        call = result[1]['tool_calls'][0]
        self.assertEqual(messages, frozen)
        self.assertEqual(call['_call_id'], 'old')
        self.assertEqual(call['function']['name'], 'functions.exec')
        literal = call['function']['arguments']['input'].removeprefix('text(await tools.exec_command(').removesuffix('));')
        self.assertEqual(json.loads(literal), args)
        self.assertEqual(result[2], messages[1])
        self.assertEqual(request, {'tools': [wrapper]})

    def test_unrelated_or_incomplete_history_call_is_not_rewritten(self):
        wrapper = copy.deepcopy(self.wrapper)
        wrapper['tools'][0]['description'] = 'tools.exec_command takes {cmd:string}'
        calls = [{'function': {'name': 'other_tool', 'arguments': {'cmd': 'Get-Date'}}},
                 {'function': {'name': 'exec_command', 'arguments': {'arguments': '{broken'}}}]
        result = routing_messages({'tools': [wrapper]}, [{'role': 'assistant', 'tool_calls': calls}])
        self.assertEqual(result[1]['tool_calls'], calls)


if __name__ == '__main__':
    unittest.main()
