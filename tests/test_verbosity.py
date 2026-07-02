"""Unit tests for verbosity resolution (feature P2, Python side).

These are pure-function tests — no engine, no LLM. Run with:  uv run pytest
"""
import pytest

from fast_rlm._runner import _normalize_verbosity


class TestNormalizeVerbosity:
    def test_backcompat_verbose_bool(self):
        # verbosity=None falls back to the legacy `verbose` flag.
        assert _normalize_verbosity(None, True) == 2
        assert _normalize_verbosity(None, False) == 0

    def test_explicit_int_levels(self):
        assert _normalize_verbosity(0, True) == 0
        assert _normalize_verbosity(1, False) == 1
        assert _normalize_verbosity(2, False) == 2

    def test_string_aliases(self):
        assert _normalize_verbosity("silent", True) == 0
        assert _normalize_verbosity("quiet", True) == 0
        assert _normalize_verbosity("summary", False) == 1
        assert _normalize_verbosity("full", False) == 2
        assert _normalize_verbosity("verbose", False) == 2

    def test_string_is_case_and_space_insensitive(self):
        assert _normalize_verbosity("  Summary ", False) == 1
        assert _normalize_verbosity("FULL", False) == 2

    def test_verbosity_overrides_verbose(self):
        # When both are given, verbosity wins over the legacy flag.
        assert _normalize_verbosity("silent", True) == 0
        assert _normalize_verbosity(2, False) == 2

    def test_bool_is_treated_as_bool_not_int(self):
        # bool is an int subclass; True must map to full (2), not int level 1.
        assert _normalize_verbosity(True, False) == 2
        assert _normalize_verbosity(False, True) == 0

    @pytest.mark.parametrize("bad", [-1, 3, 99])
    def test_int_out_of_range_raises(self, bad):
        with pytest.raises(ValueError):
            _normalize_verbosity(bad, True)

    def test_unknown_string_raises(self):
        with pytest.raises(ValueError):
            _normalize_verbosity("loud", True)

    @pytest.mark.parametrize("bad", [1.5, object(), ["full"]])
    def test_wrong_type_raises(self, bad):
        with pytest.raises(TypeError):
            _normalize_verbosity(bad, True)
