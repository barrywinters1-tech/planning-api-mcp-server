"""Agent tool dispatch and the chat loop, with the model mocked (no API calls)."""
from types import SimpleNamespace

from planner import agent


def tu(name, inp, _id="t1"):
    return SimpleNamespace(type="tool_use", name=name, input=inp, id=_id)


def txt(s):
    return SimpleNamespace(type="text", text=s)


class FakeClient:
    """Replays a script of responses; records the messages it was called with."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        snap = dict(kwargs)
        snap["messages"] = [dict(m) for m in kwargs["messages"]]  # copy; the loop mutates the live list
        self.calls.append(snap)
        content, stop = self.script.pop(0)
        return SimpleNamespace(content=content, stop_reason=stop)


def test_dispatch_generate_then_edit_then_read():
    h = agent.Holder(None)
    out = agent.dispatch("generate_programme", {"brief": "Two-storey house, start 2 March 2026, finish by end of 2026"}, h)
    assert h.project is not None and len(h.project.activities) > 20
    assert "activities" in out and "Health" in out
    # a command edit
    out2 = agent.dispatch("run_command", {"command": "finish by 1 Nov 2026"}, h)
    assert "Must finish by 2026-11-01" in out2
    assert h.project.must_finish_by is not None
    # structured edit
    out3 = agent.dispatch("apply_edits", {"ops": [{"op": "rename", "activity_id": h.project.activities[1].id, "name": "Renamed"}]}, h)
    assert "Applied" in out3 and h.project.activities[1].name == "Renamed"
    # read + health + repair + level + baseline all return text without raising
    assert "id | name" in agent.dispatch("get_schedule", {}, h)
    assert "Health" in agent.dispatch("health_check", {}, h)
    assert agent.dispatch("repair", {}, h)
    assert "Levelled" in agent.dispatch("level_resources", {}, h)
    assert "Baseline" in agent.dispatch("set_baseline", {"name": "Tender"}, h)


def test_dispatch_requires_project_first():
    h = agent.Holder(None)
    assert "No programme yet" in agent.dispatch("run_command", {"command": "fix"}, h)


def test_run_command_bad_input_is_reported_not_raised():
    h = agent.Holder(None)
    agent.dispatch("generate_programme", {"brief": "office, 3 storeys, start 2 March 2026"}, h)
    assert "Could not apply" in agent.dispatch("run_command", {"command": "do a backflip"}, h)


def test_chat_loop_drives_tools_and_returns_reply():
    client = FakeClient([
        ([tu("generate_programme", {"brief": "2-storey house, start 2 March 2026"})], "tool_use"),
        ([tu("run_command", {"command": "fix"}, "t2")], "tool_use"),
        ([txt("Done. I built the house, fixed the logic, and it now passes the checks.")], "end_turn"),
    ])
    res = agent.chat(None, [], "Build a two-storey house and make it healthy.", client=client)
    assert res["tool_calls"] == ["generate_programme", "run_command"]
    assert res["project"] is not None and len(res["project"].activities) > 20
    assert res["reply"].startswith("Done")
    assert res["history"][-1]["role"] == "assistant"
    # three model calls: tool, tool, final text
    assert len(client.calls) == 3
    # the second call carried a tool_result for the first tool_use
    second = client.calls[1]["messages"]
    assert any(m["role"] == "user" and isinstance(m["content"], list) and m["content"][0].get("type") == "tool_result" for m in second)


def test_chat_history_is_text_only():
    client = FakeClient([([txt("The critical path runs through the frame and fit-out.")], "end_turn")])
    hist = [{"role": "user", "text": "hi"}, {"role": "assistant", "text": "hello"}]
    res = agent.chat(None, hist, "what's the critical path?", client=client)
    msgs = client.calls[0]["messages"]
    assert msgs[0] == {"role": "user", "content": "hi"}
    assert msgs[-1] == {"role": "user", "content": "what's the critical path?"}
    assert res["reply"].startswith("The critical path")


def test_api_chat_endpoints(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from planner import store
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    import api
    from planner.generator import Brief, generate
    from planner.plan import draft_to_project, run_schedule

    def fake_new(project, hist, msg, **kw):
        p = draft_to_project(generate(Brief(name="Chat house", building_type="house", storeys=2, start_date=__import__("datetime").date(2026, 3, 2))))
        run_schedule(p)
        return {"reply": "Built a two-storey house.", "project": p, "history": hist + [{"role": "user", "text": msg}, {"role": "assistant", "text": "Built a two-storey house."}], "log": ["generated"], "tool_calls": ["generate_programme"]}

    monkeypatch.setattr(api.agent, "chat", fake_new)
    c = TestClient(api.app)
    r = c.post("/api/chat", json={"message": "build a house", "history": []})
    assert r.status_code == 200
    j = r.json()
    assert j["reply"].startswith("Built") and j["project"] and j["tool_calls"] == ["generate_programme"]
    pid = j["project"]["id"]
    assert any(x["id"] == pid for x in c.get("/api/projects").json())

    def fake_edit(project, hist, msg, **kw):
        project.must_finish_by = __import__("datetime").datetime(2026, 11, 1, 16)
        return {"reply": "Set the deadline.", "project": project, "history": hist, "log": ["must finish by -> 2026-11-01"], "tool_calls": ["run_command"]}

    monkeypatch.setattr(api.agent, "chat", fake_edit)
    r2 = c.post(f"/api/projects/{pid}/chat", json={"message": "finish by 1 Nov", "history": []})
    assert r2.status_code == 200 and r2.json()["project"]["must_finish_by"].startswith("2026-11-01")


def test_api_chat_without_key_is_clear(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from planner import store
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    import api

    def no_key(*a, **k):
        raise RuntimeError("Set ANTHROPIC_API_KEY on the server to use the AI assistant.")

    monkeypatch.setattr(api.agent, "chat", no_key)
    c = TestClient(api.app)
    r = c.post("/api/chat", json={"message": "hi", "history": []})
    assert r.status_code == 400 and "ANTHROPIC_API_KEY" in r.json()["detail"]
