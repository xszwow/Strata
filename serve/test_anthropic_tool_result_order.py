"""Parallel Anthropic results must retain the identity of their tool calls."""
import copy
import itertools
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve.frontend import ChatTemplate, anthropic_to_messages


def request_for(count):
    calls = [
        {"type": "tool_use", "id": f"id-{i}", "name": f"lookup_{i}", "input": {"key": str(i)}}
        for i in range(count)
    ]
    results = [
        {"type": "tool_result", "tool_use_id": f"id-{i}", "content": f"opaque-value-{i}"}
        for i in range(count)
    ]
    return {"messages": [
        {"role": "user", "content": "Look up the values."},
        {"role": "assistant", "content": calls},
        {"role": "user", "content": results},
    ]}


class AnthropicToolResultOrder(unittest.TestCase):
    def test_all_complete_permutations_render_the_same_prompt(self):
        template = ChatTemplate(Path(__file__).with_name("chat_template.jinja"))
        for count in (2, 3, 4, 5):
            request = request_for(count)
            frozen = copy.deepcopy(request)
            expected, tools, kwargs = anthropic_to_messages(request)
            prompt = template.render(expected, tools=tools, **kwargs)
            for order in itertools.permutations(range(count)):
                trial = copy.deepcopy(request)
                trial["messages"][-1]["content"] = [request["messages"][-1]["content"][i] for i in order]
                with self.subTest(count=count, order=order):
                    messages, tools, kwargs = anthropic_to_messages(trial)
                    self.assertEqual(messages, expected)
                    self.assertEqual(template.render(messages, tools=tools, **kwargs), prompt)
                    self.assertNotIn("_call_id", json.dumps(messages))
            self.assertEqual(request, frozen)

    def test_multiple_tool_rounds_are_ordered_independently(self):
        request = request_for(2)
        second = request_for(3)
        request["messages"][-1]["content"].reverse()
        second["messages"][-1]["content"].reverse()
        request["messages"] += second["messages"]
        messages, _, _ = anthropic_to_messages(request)
        self.assertEqual(
            [m["content"] for m in messages if m["role"] == "tool"],
            ["opaque-value-0", "opaque-value-1", "opaque-value-0", "opaque-value-1", "opaque-value-2"],
        )

    def test_error_and_image_results_keep_the_matching_call(self):
        request = request_for(2)
        request["messages"][-1]["content"] = [
            {"type": "tool_result", "tool_use_id": "id-1", "is_error": True, "content": "lookup failed"},
            {"type": "tool_result", "tool_use_id": "id-0", "content": [
                {"type": "text", "text": "image value"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AA=="}},
            ]},
        ]
        messages, _, _ = anthropic_to_messages(request)
        results = [m for m in messages if m["role"] == "tool"]
        self.assertEqual(results[0]["content"][0]["text"], "image value")
        self.assertEqual(results[0]["content"][1]["type"], "image")
        self.assertEqual(results[1]["content"], "lookup failed")

    def test_incomplete_or_ambiguous_ids_preserve_received_order(self):
        for mode in ("missing-id", "duplicate-id", "unknown-id", "partial"):
            request = request_for(2)
            results = request["messages"][-1]["content"]
            results.reverse()
            if mode == "missing-id":
                results[0].pop("tool_use_id")
            elif mode == "duplicate-id":
                results[0]["tool_use_id"] = results[1]["tool_use_id"]
            elif mode == "unknown-id":
                results[0]["tool_use_id"] = "unmatched"
            else:
                results.pop()
            with self.subTest(mode=mode):
                messages, _, _ = anthropic_to_messages(request)
                self.assertEqual(
                    [m["content"] for m in messages if m["role"] == "tool"],
                    [r["content"] for r in results],
                )
                self.assertNotIn("_call_id", json.dumps(messages))


if __name__ == "__main__":
    unittest.main()
