"""
test_hook_checks.py — stdlib-only tests for pre-push hook Checks 1, 2, 5, and 6.

Run: python hook/test_hook_checks.py
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile

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
check_acceptance_criteria = pre_push.check_acceptance_criteria

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
# Test 6: Check 6 — RFC with all criteria passed, branch matches → passes
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 6: Check 6 — all criteria passed, branch matches → passes ===")

with tempfile.TemporaryDirectory() as tmpdir:
    rfc_all_passed = {
        "id": "RFC_006",
        "status": "open",
        "merge_blocked_until_criteria_pass": True,
        "triggering_proposal": "prop_20260301_agent1_001",
        "acceptance_criteria": [
            {
                "ac_id": "AC_001",
                "description": "All unit tests pass",
                "check_type": "test_suite",
                "check_reference": "pytest",
                "status": "passed",
            }
        ],
    }
    with open(os.path.join(tmpdir, "RFC_006.json"), "w") as f:
        json.dump(rfc_all_passed, f)

    knowledge_6 = {
        "queue": [
            {
                "proposal_id": "prop_20260301_agent1_001",
                "branch": "feature/rfc-006",
            }
        ],
    }

    result = check_acceptance_criteria(
        knowledge_6, {}, "feature/rfc-006", tmpdir
    )
    assert_true(result is True, "all criteria passed → Check 6 passes")

# ════════════════════════════════════════════════════════════════════
# Test 7: Check 6 — one criterion pending, branch matches → blocks
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 7: Check 6 — pending criterion, branch matches → blocks ===")

with tempfile.TemporaryDirectory() as tmpdir:
    rfc_pending = {
        "id": "RFC_007",
        "status": "open",
        "merge_blocked_until_criteria_pass": True,
        "triggering_proposal": "prop_20260301_agent1_002",
        "acceptance_criteria": [
            {
                "ac_id": "AC_001",
                "description": "All unit tests pass",
                "check_type": "test_suite",
                "check_reference": "pytest",
                "status": "passed",
            },
            {
                "ac_id": "AC_002",
                "description": "Integration tests green",
                "check_type": "test_suite",
                "check_reference": "pytest::integration",
                "status": "pending",
            },
        ],
    }
    with open(os.path.join(tmpdir, "RFC_007.json"), "w") as f:
        json.dump(rfc_pending, f)

    knowledge_7 = {
        "queue": [
            {
                "proposal_id": "prop_20260301_agent1_002",
                "branch": "feature/rfc-007",
            }
        ],
    }

    # Capture stdout to check the output message contains the criterion id.
    captured = io.StringIO()
    old_stdout = sys.stdout
    sys.stdout = captured
    result = check_acceptance_criteria(
        knowledge_7, {}, "feature/rfc-007", tmpdir
    )
    sys.stdout = old_stdout
    output = captured.getvalue()

    assert_true(result is False, "pending criterion → Check 6 blocks")
    assert_true(
        "AC_002" in output,
        "block message names the failing criterion (AC_002)",
    )
    assert_true(
        "RFC_007" in output,
        "block message names the RFC ID (RFC_007)",
    )

# ════════════════════════════════════════════════════════════════════
# Test 8: Check 6 — all criteria passed but branch does not match → passes
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 8: Check 6 — branch does not match → passes ===")

with tempfile.TemporaryDirectory() as tmpdir:
    rfc_other_branch = {
        "id": "RFC_008",
        "status": "open",
        "merge_blocked_until_criteria_pass": True,
        "triggering_proposal": "prop_20260301_agent1_003",
        "acceptance_criteria": [
            {
                "ac_id": "AC_001",
                "description": "All unit tests pass",
                "check_type": "test_suite",
                "check_reference": "pytest",
                "status": "pending",  # would block — but branch won't match
            }
        ],
    }
    with open(os.path.join(tmpdir, "RFC_008.json"), "w") as f:
        json.dump(rfc_other_branch, f)

    knowledge_8 = {
        "queue": [
            {
                "proposal_id": "prop_20260301_agent1_003",
                "branch": "feature/rfc-008",
            }
        ],
    }

    result = check_acceptance_criteria(
        knowledge_8, {}, "main", tmpdir  # current branch is 'main', not the RFC branch
    )
    assert_true(
        result is True,
        "branch mismatch → RFC skipped, Check 6 passes",
    )

# ════════════════════════════════════════════════════════════════════
# Test 9: Check 6 — no RFC files in directory → passes immediately
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 9: Check 6 — no RFC files → passes immediately ===")

with tempfile.TemporaryDirectory() as empty_dir:
    result = check_acceptance_criteria({}, {}, "feature/anything", empty_dir)
    assert_true(result is True, "empty rfcs dir → Check 6 passes immediately")

# ════════════════════════════════════════════════════════════════════
# Test 10: Check 6 — RFC with status "resolved" → skipped
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 10: Check 6 — resolved RFC → skipped ===")

with tempfile.TemporaryDirectory() as tmpdir:
    rfc_resolved = {
        "id": "RFC_010",
        "status": "resolved",  # not "open" → skipped
        "merge_blocked_until_criteria_pass": True,
        "triggering_proposal": "prop_20260301_agent1_004",
        "acceptance_criteria": [
            {
                "ac_id": "AC_001",
                "description": "All unit tests pass",
                "check_type": "test_suite",
                "check_reference": "pytest",
                "status": "pending",  # would block if open
            }
        ],
    }
    with open(os.path.join(tmpdir, "RFC_010.json"), "w") as f:
        json.dump(rfc_resolved, f)

    knowledge_10 = {
        "queue": [
            {
                "proposal_id": "prop_20260301_agent1_004",
                "branch": "feature/rfc-010",
            }
        ],
    }

    result = check_acceptance_criteria(
        knowledge_10, {}, "feature/rfc-010", tmpdir
    )
    assert_true(result is True, "resolved RFC → skipped, Check 6 passes")

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
