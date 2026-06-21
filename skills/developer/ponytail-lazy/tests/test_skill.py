import importlib.util as _ilu
from pathlib import Path as _P

_ep = _P(__file__).parents[1] / "scripts" / "evaluate.py"
_spec = _ilu.spec_from_file_location("eval_ponytail_lazy", _ep)
_mod = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
evaluate = _mod.evaluate


def test_real_skill_md_passes():
    ok, errs = evaluate()
    assert ok, errs


def test_missing_ladder_rung_fails():
    # drop the YAGNI rung
    text = (_P(__file__).parents[1] / "SKILL.md").read_text(encoding="utf-8")
    mutated = text.replace("need to exist at all", "xxx")
    ok, errs = evaluate(mutated)
    assert not ok
    assert any("ladder rung" in e for e in errs)


def test_missing_deletion_binding_fails():
    text = (_P(__file__).parents[1] / "SKILL.md").read_text(encoding="utf-8")
    mutated = text.replace("Never remove an existing exported", "xxx")
    ok, errs = evaluate(mutated)
    assert not ok
    assert any("coordination" in e for e in errs)


def test_missing_escalation_binding_fails():
    text = (_P(__file__).parents[1] / "SKILL.md").read_text(encoding="utf-8")
    mutated = text.replace("escalation", "xxx")
    ok, errs = evaluate(mutated)
    assert not ok
    assert any("coordination" in e for e in errs)


def test_missing_carveout_fails():
    text = (_P(__file__).parents[1] / "SKILL.md").read_text(encoding="utf-8")
    mutated = text.replace("Lazy code without its check", "xxx")
    ok, errs = evaluate(mutated)
    assert not ok
    assert any("carve-out" in e for e in errs)


def test_host_cruft_rejected():
    text = (_P(__file__).parents[1] / "SKILL.md").read_text(encoding="utf-8")
    mutated = text + "\nRun this via the Claude Code statusline and the MCP server.\n"
    ok, errs = evaluate(mutated)
    assert not ok
    assert any("host cruft" in e for e in errs)
