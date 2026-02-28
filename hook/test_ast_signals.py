"""
test_ast_signals.py — stdlib-only tests for AST risk signal helpers.

Tests compute_mechanical_only() and compute_public_api_signature_changed()
with synthetic source strings.

Run: python hook/test_ast_signals.py
"""
from __future__ import annotations

import importlib.util
import os
import sys

# ── Import the hook module (filename contains a hyphen) ─────────────
_spec = importlib.util.spec_from_file_location(
    "pre_push",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "pre-push.py"),
)
assert _spec is not None and _spec.loader is not None
pre_push = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pre_push)

compute_mechanical_only = pre_push.compute_mechanical_only
compute_public_api_signature_changed = pre_push.compute_public_api_signature_changed
compute_auth_pattern_touched = pre_push.compute_auth_pattern_touched
compute_invariant_referenced_file_modified = pre_push.compute_invariant_referenced_file_modified
compute_high_fan_in = pre_push.compute_high_fan_in
derive_ast_change_type = pre_push.derive_ast_change_type
build_risk_signals = pre_push.build_risk_signals

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


# ════════════════════════════════════════════════════════════════════
# Test 1: Docstring-only change → mechanical_only: True,
#          public_api_signature_changed: False
# ════════════════════════════════════════════════════════════════════
print("=== Test 1: Docstring-only change ===")

base_1 = '''\
def greet(name):
    """Say hello."""
    return f"Hello, {name}"
'''

head_1 = '''\
def greet(name):
    """Say hello to someone nicely."""
    return f"Hello, {name}"
'''

assert_eq(compute_mechanical_only(base_1, head_1), True,
          "docstring change → mechanical_only: True")
assert_eq(compute_public_api_signature_changed(base_1, head_1), False,
          "docstring change → public_api_signature_changed: False")

# ════════════════════════════════════════════════════════════════════
# Test 2: Argument added → public_api_signature_changed: True
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 2: Argument added to function ===")

base_2 = '''\
def foo(x):
    return x + 1
'''

head_2 = '''\
def foo(x, y):
    return x + y
'''

assert_eq(compute_public_api_signature_changed(base_2, head_2), True,
          "def foo(x) → def foo(x, y) → public_api_signature_changed: True")

# ════════════════════════════════════════════════════════════════════
# Test 3: Body change (same signature) → mechanical_only: False,
#          public_api_signature_changed: False
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 3: Body change, same signature ===")

base_3 = '''\
def foo(x):
    return x + 1
'''

head_3 = '''\
def foo(x):
    return x * 2
'''

assert_eq(compute_mechanical_only(base_3, head_3), False,
          "body change → mechanical_only: False")
assert_eq(compute_public_api_signature_changed(base_3, head_3), False,
          "same signature → public_api_signature_changed: False")

# ════════════════════════════════════════════════════════════════════
# Test 4: New file (base=None) → mechanical_only: False,
#          public_api_signature_changed: True
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 4: New file ===")

head_4 = '''\
def hello():
    print("world")
'''

assert_eq(compute_mechanical_only(None, head_4), False,
          "new file → mechanical_only: False")
assert_eq(compute_public_api_signature_changed(None, head_4), True,
          "new file → public_api_signature_changed: True")

# ════════════════════════════════════════════════════════════════════
# Test 5: Syntactically invalid head → safe defaults, no exception
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 5: Syntactically invalid head content ===")

base_5 = "def valid(): pass\n"
head_5 = "def broken(:\n"

assert_eq(compute_mechanical_only(base_5, head_5), False,
          "invalid syntax → mechanical_only: False (safe default)")
assert_eq(compute_public_api_signature_changed(base_5, head_5), True,
          "invalid syntax → public_api_signature_changed: True (safe default)")

# Also test invalid base
assert_eq(compute_mechanical_only(head_5, base_5), False,
          "invalid base syntax → mechanical_only: False (safe default)")
assert_eq(compute_public_api_signature_changed(head_5, base_5), True,
          "invalid base syntax → public_api_signature_changed: True (safe default)")

# ════════════════════════════════════════════════════════════════════
# Test 6: Auth pattern touched — verify_token() call with pattern
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 6: Auth pattern touched ====")

head_6_match = '''\
import jwt

def handler(request):
    token = request.headers["Authorization"]
    payload = verify_token(token)
    return payload["user_id"]
'''

head_6_no_match = '''\
def add(a, b):
    return a + b
'''

assert_eq(compute_auth_pattern_touched(head_6_match, ["verify_token"]), True,
          "verify_token() present → touched_auth: True")
assert_eq(compute_auth_pattern_touched(head_6_no_match, ["verify_token"]), False,
          "no pattern present → touched_auth: False")

# ════════════════════════════════════════════════════════════════════
# Test 7: Invariant-referenced file modified
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 7: Invariant-referenced file modified ====")

state_records_7 = [
    {
        "id": "rec-1",
        "path": "./src/auth/login.ts",
        "invariants_touched": ["auth_model"],
        "dependencies": ["./src/utils/crypto.ts", "src/auth/helpers.ts"],
    },
    {
        "id": "rec-2",
        "path": "src/api/routes.ts",
        "invariants_touched": [],
        "dependencies": ["src/utils/crypto.ts"],
    },
]

assert_eq(
    compute_invariant_referenced_file_modified("src/utils/crypto.ts", state_records_7),
    True,
    "crypto.ts in deps of record with invariants_touched → True",
)
assert_eq(
    compute_invariant_referenced_file_modified("src/api/routes.ts", state_records_7),
    False,
    "routes.ts not in any deps → False",
)

# ════════════════════════════════════════════════════════════════════
# Test 8: High fan-in
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 8: High fan-in ====")

state_records_8 = [
    {"id": "r1", "dependencies": ["src/shared/utils.ts"]},
    {"id": "r2", "dependencies": ["src/shared/utils.ts", "src/other.ts"]},
    {"id": "r3", "dependencies": ["./src/shared/utils.ts"]},
    {"id": "r4", "dependencies": ["src/unrelated.ts"]},
]

assert_eq(
    compute_high_fan_in("src/shared/utils.ts", state_records_8), True,
    "utils.ts in 3 records → high_fan_in: True",
)
assert_eq(
    compute_high_fan_in("src/other.ts", state_records_8), False,
    "other.ts in 1 record → high_fan_in: False (< 3)",
)

# Also test with only 2 matches
state_records_8b = [
    {"id": "r1", "dependencies": ["src/shared/utils.ts"]},
    {"id": "r2", "dependencies": ["src/shared/utils.ts"]},
]
assert_eq(
    compute_high_fan_in("src/shared/utils.ts", state_records_8b), False,
    "utils.ts in 2 records → high_fan_in: False (< 3)",
)

# ════════════════════════════════════════════════════════════════════
# Test 9: derive_ast_change_type
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 9: derive_ast_change_type ====")

assert_eq(derive_ast_change_type(True, False), "mechanical",
          "mechanical_only=True → mechanical")
assert_eq(derive_ast_change_type(True, True), "mechanical",
          "mechanical_only=True wins over structural")
assert_eq(derive_ast_change_type(False, True), "structural",
          "public_api_changed=True → structural")
assert_eq(derive_ast_change_type(False, False), "behavioral",
          "neither → behavioral")

# ════════════════════════════════════════════════════════════════════
# Test 10: build_risk_signals — mechanical_only final flag
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 10: build_risk_signals mechanical_only flag ====")

# Docstring-only change, no security patterns, no invariant/fan-in
base_10 = '''\
def greet(name):
    """Say hello."""
    return f"Hello, {name}"
'''
head_10 = '''\
def greet(name):
    """Say hello nicely."""
    return f"Hello, {name}"
'''

signals_10 = build_risk_signals(
    base_content=base_10,
    head_content=head_10,
    filepath="src/greet.py",
    state_records=[],
    security_patterns=[],
)
assert_eq(signals_10["mechanical_only"], True,
          "pure mechanical + no other flags → mechanical_only: True")
assert_eq(signals_10["ast_change_type"], "mechanical",
          "ast_change_type: mechanical")

# ════════════════════════════════════════════════════════════════════
# Test 11: build_risk_signals — security pattern match demotes
#          mechanical_only even when body is only comments
# ════════════════════════════════════════════════════════════════════
print("\n=== Test 11: Security pattern match demotes mechanical_only ====")

# The head content has a comment-only body change BUT references a
# security pattern — mechanical_only should be False.
base_11 = '''\
def process(request):
    """Handle request."""
    token = verify_token(request.token)
    return token
'''
head_11 = '''\
def process(request):
    """Handle the incoming request."""
    token = verify_token(request.token)
    return token
'''

signals_11 = build_risk_signals(
    base_content=base_11,
    head_content=head_11,
    filepath="src/handler.py",
    state_records=[],
    security_patterns=["verify_token"],
)
assert_eq(signals_11["ast_change_type"], "mechanical",
          "docstring-only → ast_change_type: mechanical")
assert_eq(signals_11["touched_auth_or_permission_patterns"], True,
          "verify_token present → auth: True")
assert_eq(signals_11["mechanical_only"], False,
          "security pattern match → mechanical_only: False despite mechanical AST")

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
