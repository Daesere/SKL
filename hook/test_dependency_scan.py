"""
test_dependency_scan.py — stdlib-only tests for Check 4 import helpers.

Tests extract_imports(), resolve_to_repo_path(), and scan_imports()
using a temporary directory as a mock repo root.

Run: python hook/test_dependency_scan.py
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile

# ── Import the hook module (filename contains a hyphen) ─────────────
_spec = importlib.util.spec_from_file_location(
    "pre_push",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "pre-push.py"),
)
assert _spec is not None and _spec.loader is not None
pre_push = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pre_push)

extract_imports = pre_push.extract_imports
resolve_to_repo_path = pre_push.resolve_to_repo_path
scan_imports = pre_push.scan_imports
validate_dependencies = pre_push.validate_dependencies
build_proposal = pre_push.build_proposal
atomic_write_knowledge = pre_push.atomic_write_knowledge

passed = 0
failed = 0


def assert_eq(actual: object, expected: object, label: str) -> None:
    global passed, failed
    if actual == expected:
        passed += 1
        print(f"  PASS — {label}")
    else:
        failed += 1
        print(f"  FAIL — {label}  (got {actual!r}, expected {expected!r})")


def _mkdir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def _touch(path: str) -> None:
    _mkdir(os.path.dirname(path))
    with open(path, "w") as f:
        f.write("")


# ════════════════════════════════════════════════════════════════════
# Build a mock repo tree inside a temp directory
# ════════════════════════════════════════════════════════════════════
tmpdir = tempfile.mkdtemp(prefix="skl_test_dep_")

# app/utils/tokens.py
_touch(os.path.join(tmpdir, "app", "utils", "tokens.py"))
# app/models/__init__.py
_touch(os.path.join(tmpdir, "app", "models", "__init__.py"))
# app/models/user.py
_touch(os.path.join(tmpdir, "app", "models", "user.py"))


# ════════════════════════════════════════════════════════════════════
# Test 1: extract_imports — various import forms
# ════════════════════════════════════════════════════════════════════
print("=== Test 1: extract_imports ===")

source_1 = """\
import os
import json
from app.utils.tokens import generate
from app.models import user
from . import something
"""

imports_1 = extract_imports(source_1)

assert_eq("os" in imports_1, True, "import os → 'os' extracted")
assert_eq("json" in imports_1, True, "import json → 'json' extracted")
assert_eq("app.utils.tokens" in imports_1, True,
          "from app.utils.tokens import generate → 'app.utils.tokens'")
assert_eq("app.models" in imports_1, True,
          "from app.models import user → 'app.models'")
# Relative import with no module should be skipped
assert_eq("something" not in imports_1, True,
          "from . import something → module string skipped (relative, no module)")


# ════════════════════════════════════════════════════════════════════
# Test 2: resolve_to_repo_path — .py file resolution
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 2: resolve_to_repo_path (.py) ===")

result_tokens = resolve_to_repo_path("app.utils.tokens", tmpdir)
assert_eq(
    result_tokens,
    os.path.normpath("app/utils/tokens.py"),
    "app.utils.tokens → app/utils/tokens.py",
)


# ════════════════════════════════════════════════════════════════════
# Test 3: resolve_to_repo_path — __init__.py resolution
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 3: resolve_to_repo_path (__init__.py) ===")

result_models = resolve_to_repo_path("app.models", tmpdir)
assert_eq(
    result_models,
    os.path.normpath("app/models/__init__.py"),
    "app.models → app/models/__init__.py",
)


# ════════════════════════════════════════════════════════════════════
# Test 4: resolve_to_repo_path — stdlib / third-party → None
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 4: resolve_to_repo_path (stdlib) ===")

result_os = resolve_to_repo_path("os", tmpdir)
assert_eq(result_os, None, "os → None (stdlib, not in repo)")

result_json = resolve_to_repo_path("json", tmpdir)
assert_eq(result_json, None, "json → None (stdlib, not in repo)")


# ════════════════════════════════════════════════════════════════════
# Test 5: scan_imports — end-to-end with mock repo
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 5: scan_imports end-to-end ===")

source_5 = """\
import os
from app.utils.tokens import generate
from app.models import user
"""

resolved = scan_imports("app/main.py", source_5, tmpdir)

assert_eq(
    os.path.normpath("app/utils/tokens.py") in resolved, True,
    "app.utils.tokens resolved to app/utils/tokens.py",
)
assert_eq(
    os.path.normpath("app/models/__init__.py") in resolved, True,
    "app.models resolved to app/models/__init__.py",
)
# os should NOT appear (no os.py in our mock repo)
has_os = any("os" in p and "tokens" not in p and "models" not in p
             for p in resolved)
assert_eq(has_os, False, "os (stdlib) filtered out")


# ════════════════════════════════════════════════════════════════════
# Test 6: Syntax error → empty list, no exception
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 6: Syntax error ===")

bad_source = "from app.utils import (\n"

assert_eq(extract_imports(bad_source), [],
          "syntax error → empty list from extract_imports")
assert_eq(scan_imports("bad.py", bad_source, tmpdir), [],
          "syntax error → empty list from scan_imports")


# ════════════════════════════════════════════════════════════════════
# Test 7: validate_dependencies — undeclared imports
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 7: undeclared imports ===")

scanned_7 = [
    os.path.normpath("app/utils/tokens.py"),
    os.path.normpath("app/models/__init__.py"),
]
state_record_7: dict = {
    "path": "app/main.py",
    "semantic_scope": "backend",
    "dependencies": [os.path.normpath("app/utils/tokens.py")],
}
all_records_7: list = [state_record_7]

result_7 = validate_dependencies(
    scanned_7, state_record_7, all_records_7, None, "backend",
)
assert_eq(
    os.path.normpath("app/models/__init__.py") in result_7["undeclared_imports"],
    True,
    "app/models/__init__.py not in declared deps → undeclared_imports",
)


# ════════════════════════════════════════════════════════════════════
# Test 8: validate_dependencies — stale declared deps
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 8: stale declared deps ===")

scanned_8: list = [os.path.normpath("app/utils/tokens.py")]
state_record_8: dict = {
    "path": "app/main.py",
    "semantic_scope": "backend",
    "dependencies": [
        os.path.normpath("app/utils/tokens.py"),
        os.path.normpath("app/legacy/old.py"),
    ],
}
result_8 = validate_dependencies(
    scanned_8, state_record_8, [state_record_8], None, "backend",
)
assert_eq(
    os.path.normpath("app/legacy/old.py") in result_8["stale_declared_deps"],
    True,
    "app/legacy/old.py declared but not imported → stale_declared_deps",
)


# ════════════════════════════════════════════════════════════════════
# Test 9: validate_dependencies — cross-scope undeclared
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 9: cross-scope undeclared import ===")

# The scanned import resolves to a file registered under a *different* scope.
scanned_9 = [os.path.normpath("infra/deploy/config.py")]
state_record_9: dict = {
    "path": "app/main.py",
    "semantic_scope": "backend",
    "dependencies": [],
}
all_records_9 = [
    state_record_9,
    {
        "path": "infra/deploy/config.py",
        "semantic_scope": "infra",
        "dependencies": [],
    },
]
result_9 = validate_dependencies(
    scanned_9, state_record_9, all_records_9, None, "backend",
)
assert_eq(
    os.path.normpath("infra/deploy/config.py") in result_9["cross_scope_undeclared"],
    True,
    "import from 'infra' scope by 'backend' agent → cross_scope_undeclared",
)


# ════════════════════════════════════════════════════════════════════
# Test 10: known_expected_cross_scope_imports exclusion
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 10: known expected cross-scope exclusion ===")

scope_defs_10: dict = {
    "known_expected_cross_scope_imports": [
        "infra/deploy/config.py",
    ],
}
result_10 = validate_dependencies(
    scanned_9, state_record_9, all_records_9, scope_defs_10, "backend",
)
assert_eq(
    result_10["cross_scope_undeclared"],
    [],
    "import in known_expected list → excluded from cross_scope_undeclared",
)

# Also test prefix matching (entry ending with /)
scope_defs_10b: dict = {
    "known_expected_cross_scope_imports": [
        "infra/deploy/",
    ],
}
result_10b = validate_dependencies(
    scanned_9, state_record_9, all_records_9, scope_defs_10b, "backend",
)
assert_eq(
    result_10b["cross_scope_undeclared"],
    [],
    "prefix match with trailing / → excluded from cross_scope_undeclared",
)


# ════════════════════════════════════════════════════════════════════
# Test 11: New file (state_record=None) — no undeclared/stale,
#           cross-scope still checked
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 11: New file (state_record=None) ===")

scanned_11 = [os.path.normpath("infra/deploy/config.py")]
result_11 = validate_dependencies(
    scanned_11, None, all_records_9, None, "backend",
)
assert_eq(
    result_11["undeclared_imports"], [],
    "new file → no undeclared warnings",
)
assert_eq(
    result_11["stale_declared_deps"], [],
    "new file → no stale warnings",
)
assert_eq(
    os.path.normpath("infra/deploy/config.py") in result_11["cross_scope_undeclared"],
    True,
    "new file but cross-scope import still checked",
)


# ════════════════════════════════════════════════════════════════════
# Test 12: Atomic write — original untouched when .tmp is corrupt
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 12: Atomic write safety ===")

import json as _json

atomic_dir = tempfile.mkdtemp(prefix="skl_atomic_")
kn_path = os.path.join(atomic_dir, "knowledge.json")

original = {"state": [], "queue": [{"proposal_id": "existing"}]}
with open(kn_path, "w", encoding="utf-8") as f:
    _json.dump(original, f, indent=2)
    f.write("\n")

# Write a corrupt .tmp file manually then try os.replace to a
# *read-only* target — on Windows this still succeeds, so instead
# we verify the happy-path: atomic_write_knowledge writes correctly.
new_knowledge = {"state": [], "queue": [
    {"proposal_id": "existing"},
    {"proposal_id": "new_one"},
]}
# Monkey-patch sys.exit to prevent actual exit during test.
_real_exit = sys.exit
exit_called_with: list = []


def _mock_exit(code: int = 0) -> None:
    exit_called_with.append(code)
    raise SystemExit(code)


sys.exit = _mock_exit  # type: ignore[assignment]

try:
    atomic_write_knowledge(kn_path, new_knowledge)
except SystemExit:
    pass
finally:
    sys.exit = _real_exit  # type: ignore[assignment]

# Read back and verify
with open(kn_path, "r", encoding="utf-8") as f:
    written_back = _json.load(f)

assert_eq(
    len(written_back.get("queue", [])), 2,
    "knowledge.json updated atomically — 2 proposals in queue",
)
assert_eq(
    written_back["queue"][1]["proposal_id"], "new_one",
    "second proposal is the newly appended one",
)

# Verify failure path: make the path unwritable to trigger error.
# We create a directory with the .tmp name so open() fails.
bad_kn_path = os.path.join(atomic_dir, "bad_knowledge.json")
with open(bad_kn_path, "w", encoding="utf-8") as f:
    _json.dump(original, f, indent=2)
    f.write("\n")

bad_tmp = bad_kn_path + ".tmp"
os.makedirs(bad_tmp, exist_ok=True)  # .tmp is a dir → open() will fail

exit_called_with.clear()
sys.exit = _mock_exit  # type: ignore[assignment]
try:
    atomic_write_knowledge(bad_kn_path, new_knowledge)
except SystemExit:
    pass
finally:
    sys.exit = _real_exit  # type: ignore[assignment]

assert_eq(
    exit_called_with, [1],
    "atomic_write_knowledge calls sys.exit(1) on write failure",
)

# Original file should be untouched.
with open(bad_kn_path, "r", encoding="utf-8") as f:
    untouched = _json.load(f)
assert_eq(
    len(untouched.get("queue", [])), 1,
    "original knowledge.json untouched after failed write",
)

# Cleanup atomic dir
import shutil as _shutil_atomic
_shutil_atomic.rmtree(atomic_dir, ignore_errors=True)


# ════════════════════════════════════════════════════════════════════
# Cleanup & Summary
# ════════════════════════════════════════════════════════════════════
import shutil
shutil.rmtree(tmpdir, ignore_errors=True)

print()
print("════════════════════════════════════")
if failed == 0:
    print(f"All {passed} tests passed.")
else:
    print(f"{failed} of {passed + failed} tests FAILED.")
    sys.exit(1)
print("════════════════════════════════════")
