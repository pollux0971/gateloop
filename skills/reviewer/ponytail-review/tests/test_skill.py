import importlib.util as _ilu
from pathlib import Path as _P

_ep = _P(__file__).parents[1] / "scripts" / "evaluate.py"
_spec = _ilu.spec_from_file_location("eval_ponytail_review", _ep)
_mod = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
evaluate = _mod.evaluate


def _md():
    return (_P(__file__).parents[1] / "SKILL.md").read_text(encoding="utf-8")


def test_real_skill_md_passes():
    ok, errs = evaluate()
    assert ok, errs


def test_missing_tag_fails():
    ok, errs = evaluate(_md().replace("yagni:", "xxx:"))
    assert not ok
    assert any("finding tag" in e for e in errs)


def test_missing_contract_binding_fails():
    ok, errs = evaluate(_md().replace("bounded by the contract", "xxx"))
    assert not ok
    assert any("required marker" in e for e in errs)


def test_missing_minimum_check_binding_fails():
    ok, errs = evaluate(_md().replace("Never flag the ponytail minimum", "xxx"))
    assert not ok
    assert any("required marker" in e for e in errs)


def test_host_cruft_rejected():
    ok, errs = evaluate(_md() + "\nWire this through the Claude Code statusline / MCP server.\n")
    assert not ok
    assert any("host cruft" in e for e in errs)
