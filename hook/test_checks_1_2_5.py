"""
test_checks_1_2_5.py — stdlib-only tests for pre-push hook Checks 1, 2, and 5.

Run: python hook/test_checks_1_2_5.py
"""
from __future__ import annotations

import sys
import os

# Ensure the hook directory is importable.
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

# Import the functions under test from the pre-push hook module.
# Python allows importing .py files without the hyphen trick because the
# filename is pre-push.py which contains a hyphen — we use importlib.
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "pre_push",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "pre-push.py"),
)
assert _spec is not None and _spec.loader is not None
pre_push = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pre_push)

check_file_scope = pre_push.check_file_scope
check_semantic_scope = pre_push.check_semantic_scope
check_queue_budget = pre_push.check_queue_budget

passed = 0
failed = 0


def assert_true(condition: bool, label: str) -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS — {label}")
    else:
        failed += 1
        print(f"  FAIL — {label}")


# ════════════════════════════════════════════════════════════════════
# Test 1: Check 1 — out-of-scope file detection
# ════════════════════════════════════════════════════════════════════
print("=== Test 1: Check 1 — out-of-scope file detection ===")

violations = check_file_scope(
    modified_files=["app/auth.py", "app/models/user.py"],
    file_scope=["app/auth.py"],
)

assert_true(
    not violations["app/auth.py"].out_of_scope,
    "app/auth.py is in file_scope → not flagged",
)
assert_true(
    violations["app/models/user.py"].out_of_scope,
    "app/models/user.py is NOT in file_scope → flagged out_of_scope",
)

# ════════════════════════════════════════════════════════════════════
# Test 2: Check 2 — forbidden_path_prefixes → cross_scope_flag
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 2: Check 2 — forbidden prefix triggers cross_scope_flag ===")

scope_entry = {
    "allowed_paths": [],
    "allowed_path_prefixes": ["app/auth/"],
    "forbidden_path_prefixes": ["infra/"],
}

violations_2 = check_file_scope(
    modified_files=["infra/deploy.py"],
    file_scope=["infra/deploy.py"],  # in file_scope, so Check 1 passes
)
violations_2 = check_semantic_scope(violations_2, scope_entry)

assert_true(
    violations_2["infra/deploy.py"].cross_scope_flag,
    "infra/deploy.py under forbidden prefix → cross_scope_flag: True",
)

# ════════════════════════════════════════════════════════════════════
# Test 3: Check 2 — allowed_paths exact match passes
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 3: Check 2 — allowed_paths exact match passes ===")

scope_entry_exact = {
    "allowed_paths": ["config/settings.json"],
    "allowed_path_prefixes": ["app/"],
    "forbidden_path_prefixes": ["config/"],
}

violations_3 = check_file_scope(
    modified_files=["config/settings.json"],
    file_scope=["config/settings.json"],
)
violations_3 = check_semantic_scope(violations_3, scope_entry_exact)

assert_true(
    not violations_3["config/settings.json"].cross_scope_flag,
    "config/settings.json in allowed_paths → cross_scope_flag: False "
    "(exact match takes priority over forbidden prefix)",
)

# ════════════════════════════════════════════════════════════════════
# Test 4: Check 5 — queue full (count >= queue_max)
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 4: Check 5 — queue full ===")

knowledge_full = {
    "queue": [{"status": "pending"} for _ in range(15)],
}
error = check_queue_budget(knowledge_full, queue_max=15)
assert_true(
    error is not None,
    "15 pending with queue_max=15 → Check 5 triggers",
)
assert_true(
    "15/15" in (error or ""),
    "Error message contains '15/15'",
)

# ════════════════════════════════════════════════════════════════════
# Test 5: Check 5 — queue not full (count < queue_max)
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 5: Check 5 — queue under budget ===")

knowledge_ok = {
    "queue": [{"status": "pending"} for _ in range(14)],
}
error_ok = check_queue_budget(knowledge_ok, queue_max=15)
assert_true(
    error_ok is None,
    "14 pending with queue_max=15 → Check 5 passes",
)

# ════════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════════
print()
print("════════════════════════════════════")
if failed == 0:
    print(f"All {passed} tests passed.")
else:
    print(f"{failed} of {passed + failed} tests FAILED.")
    sys.exit(1)
print("════════════════════════════════════")
