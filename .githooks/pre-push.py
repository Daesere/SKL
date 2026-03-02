# SKL_HOOK_V1.4
"""
pre-push.py — SKL v1.4 Pre-Push Enforcement Hook

Runs as a Git pre-push hook. Validates file scope, semantic scope,
and queue budget before allowing a push. Designed to run with
Python 3.8+ standard library only — no third-party dependencies.

Execution order: startup → Check 1 → Check 2 → Check 5 → Check 6 → Check 7 →
  Check 3 → Check 4 → write.
"""
from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

# ── Module-level constants ──────────────────────────────────────────
HIGH_FAN_IN_THRESHOLD: int = 3
PROPOSAL_ID_FORMAT: str = "prop_{date}_{agent_id}_{seq:03d}"

# ── Hardcoded defaults matching DEFAULT_HOOK_CONFIG ─────────────────

DEFAULT_HOOK_CONFIG: Dict[str, Any] = {
    "skl_version": "1.4",
    "queue_max": 15,
    "circuit_breaker_threshold": 3,
    "review_threshold": 5,
    "base_branch": "main",
    "python_executable": "python3",
}


# ── Data structures ─────────────────────────────────────────────────

class FileViolation:
    """Tracks per-file violations collected by Checks 1 and 2."""

    __slots__ = ("path", "out_of_scope", "cross_scope_flag")

    def __init__(self, path: str) -> None:
        self.path = path
        self.out_of_scope: bool = False
        self.cross_scope_flag: bool = False

    def __repr__(self) -> str:
        flags = []
        if self.out_of_scope:
            flags.append("out_of_scope")
        if self.cross_scope_flag:
            flags.append("cross_scope")
        return f"FileViolation({self.path!r}, {', '.join(flags) or 'clean'})"


# ── Startup helpers ─────────────────────────────────────────────────

def find_repo_root(start: str) -> Optional[str]:
    """Walk up from *start* until a directory containing .git is found."""
    current = os.path.abspath(start)
    while True:
        if os.path.isdir(os.path.join(current, ".git")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def read_json_file(path: str) -> Optional[Any]:
    """Read and parse a JSON file, returning None on any failure."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def load_hook_config(skl_dir: str) -> Dict[str, Any]:
    """Load .skl/hook_config.json, falling back to hardcoded defaults."""
    config = read_json_file(os.path.join(skl_dir, "hook_config.json"))
    if config is None or not isinstance(config, dict):
        return dict(DEFAULT_HOOK_CONFIG)
    # Merge with defaults so missing keys get filled in.
    merged = dict(DEFAULT_HOOK_CONFIG)
    merged.update(config)
    return merged


# ── Check 1: File Scope Validation ──────────────────────────────────

def get_modified_files(repo_root: str, base_branch: str) -> Optional[List[str]]:
    """
    Return the list of files modified between *base_branch* and HEAD,
    as repo-relative paths. Returns None if git diff fails.
    """
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", f"{base_branch}...HEAD"],
            capture_output=True,
            text=True,
            cwd=repo_root,
        )
        if result.returncode != 0:
            return None
        files = [f for f in result.stdout.strip().splitlines() if f]
        return files
    except (OSError, subprocess.SubprocessError):
        return None


def check_file_scope(
    modified_files: List[str],
    file_scope: List[str],
) -> Dict[str, FileViolation]:
    """
    Check 1 — compare modified files against the agent's file_scope.

    Returns a dict of path → FileViolation for *every* modified file.
    Files not in file_scope have out_of_scope set to True.

    If file_scope is empty the check is skipped and no files are
    marked out_of_scope (empty means "allow all files").
    """
    scope_set = set(file_scope)
    violations: Dict[str, FileViolation] = {}

    for path in modified_files:
        v = FileViolation(path)
        if scope_set and path not in scope_set:
            v.out_of_scope = True
        violations[path] = v

    return violations


# ── Check 2: Semantic Scope Validation ──────────────────────────────

def check_semantic_scope(
    violations: Dict[str, FileViolation],
    scope_entry: Optional[Dict[str, Any]],
) -> Dict[str, FileViolation]:
    """
    Check 2 — validate each modified file against the agent's semantic
    scope definition from scope_definitions.json.

    If *scope_entry* is None (scope_definitions not loaded), the check
    is skipped silently and violations are returned unchanged.

    For each file:
      1. If it matches an entry in allowed_paths → passes.
      2. If it starts with any allowed_path_prefixes entry → passes.
      3. If it starts with any forbidden_path_prefixes entry → cross_scope_flag.
    """
    if scope_entry is None:
        return violations

    allowed_paths: List[str] = scope_entry.get("allowed_paths") or []
    allowed_prefixes: List[str] = scope_entry.get("allowed_path_prefixes") or []
    forbidden_prefixes: List[str] = scope_entry.get("forbidden_path_prefixes") or []

    allowed_set = set(allowed_paths)

    for path, v in violations.items():
        # 1. Exact allowed path match
        if path in allowed_set:
            continue

        # 2. Allowed prefix match
        if any(path.startswith(prefix) for prefix in allowed_prefixes):
            continue

        # 3. Forbidden prefix match
        if any(path.startswith(prefix) for prefix in forbidden_prefixes):
            v.cross_scope_flag = True

    return violations


# ── Check 5: Queue Budget ───────────────────────────────────────────

def check_queue_budget(
    knowledge: Dict[str, Any],
    queue_max: int,
) -> Optional[str]:
    """
    Check 5 — count pending proposals in the queue.

    Returns an error message string if the queue is full, or None if OK.
    """
    queue = knowledge.get("queue", [])
    pending_count = sum(
        1 for p in queue
        if isinstance(p, dict) and p.get("status") == "pending"
    )
    if pending_count >= queue_max:
        return (
            f"SKL: Queue is full ({pending_count}/{queue_max} pending proposals). "
            "Wait for the Orchestrator to process the Queue before pushing."
        )
    return None


# ── Check 6: Acceptance Criteria Gate ─────────────────────────────

def check_acceptance_criteria(
    knowledge: Dict[str, Any],
    agent_context: Dict[str, Any],
    current_branch: str,
    rfcs_dir: str,
) -> bool:
    """
    Check 6 — block push when the current branch is linked to an RFC
    with any uncompleted acceptance criteria.

    RFC-to-branch resolution uses the triggering_proposal's ``branch``
    field from the Queue. Returns True (allow push) if no applicable
    RFC has unmet criteria; False (block push) otherwise.

    *rfcs_dir* is the path to the .skl/rfcs/ directory.
    """
    # If the rfcs directory is absent or empty, nothing to check.
    if not os.path.isdir(rfcs_dir):
        return True

    rfc_files = [
        os.path.join(rfcs_dir, f)
        for f in os.listdir(rfcs_dir)
        if f.endswith(".json")
    ]
    if not rfc_files:
        return True

    # Build a lookup of proposal_id → proposal from the queue.
    queue: List[Dict[str, Any]] = knowledge.get("queue", [])
    queue_by_id: Dict[str, Dict[str, Any]] = {
        p["proposal_id"]: p
        for p in queue
        if isinstance(p, dict) and "proposal_id" in p
    }

    for rfc_path in rfc_files:
        try:
            with open(rfc_path, "r", encoding="utf-8") as fh:
                rfc = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            print(
                f"SKL: Warning — could not parse RFC file {rfc_path}: {exc}",
                file=sys.stderr,
            )
            continue

        # Only enforce when the flag is explicitly set.
        if rfc.get("merge_blocked_until_criteria_pass") is not True:
            continue

        # Only enforce on open RFCs.
        if rfc.get("status") != "open":
            continue

        # Resolve the triggering proposal.
        triggering_id = rfc.get("triggering_proposal")
        if not triggering_id:
            continue
        proposal = queue_by_id.get(triggering_id)
        if proposal is None:
            continue

        # Skip if the proposal has no branch field.
        proposal_branch = proposal.get("branch")
        if not proposal_branch:
            continue

        # Only enforce when the current branch matches the RFC's branch.
        if proposal_branch != current_branch:
            continue

        # Collect unmet acceptance criteria.
        criteria: List[Dict[str, Any]] = rfc.get("acceptance_criteria") or []
        failing = [
            c for c in criteria
            if isinstance(c, dict) and c.get("status") != "passed"
        ]
        if not failing:
            continue

        # Block the push and name every failing criterion.
        rfc_id = rfc.get("id", os.path.basename(rfc_path))
        print(
            f"SKL: Push blocked. RFC {rfc_id} has unmet acceptance criteria:"
        )
        for c in failing:
            ac_id = c.get("ac_id", "?")
            description = c.get("description", "(no description)")
            check_type = c.get("check_type", "")
            check_reference = c.get("check_reference", "")
            print(
                f"  - [{ac_id}] {description} "
                f"(check_type: {check_type}, reference: {check_reference})"
            )
        print(
            "Run 'SKL: Run CI Check' in VS Code to update criterion status "
            "after your tests pass."
        )
        return False

    return True


# ── Check 7: RFC Scope Pause ──────────────────────────────────

def check_rfc_scope_pause(
    knowledge: Dict[str, Any],
    agent_context: Dict[str, Any],
    rfcs_dir: str,
) -> bool:
    """
    Check 7 — block push when any open RFC whose human response deadline
    has passed shares its triggering proposal's semantic scope with the
    current agent.

    An expired deadline means the scope is paused until that RFC is
    resolved. Uses UTC comparison for Python 3.8 compatibility.
    """
    if not os.path.isdir(rfcs_dir):
        return True

    rfc_files = [
        os.path.join(rfcs_dir, f)
        for f in os.listdir(rfcs_dir)
        if f.endswith(".json")
    ]
    if not rfc_files:
        return True

    # Build a lookup of proposal_id → proposal from the queue.
    queue: List[Dict[str, Any]] = knowledge.get("queue", [])
    queue_by_id: Dict[str, Dict[str, Any]] = {
        p["proposal_id"]: p
        for p in queue
        if isinstance(p, dict) and "proposal_id" in p
    }

    agent_scope: str = agent_context.get("semantic_scope", "")
    now_utc = datetime.now(timezone.utc)

    for rfc_path in rfc_files:
        try:
            with open(rfc_path, "r", encoding="utf-8") as fh:
                rfc = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            print(
                f"SKL: Warning — could not parse RFC file {rfc_path}: {exc}",
                file=sys.stderr,
            )
            continue

        # Only enforce on open RFCs.
        if rfc.get("status") != "open":
            continue

        # Parse and compare deadline.
        raw_deadline = rfc.get("human_response_deadline")
        if not raw_deadline:
            continue
        try:
            deadline_dt = datetime.fromisoformat(
                raw_deadline.replace("Z", "+00:00")
            )
        except (ValueError, AttributeError):
            continue

        # If deadline has NOT passed, skip.
        if deadline_dt > now_utc:
            continue

        # Deadline has passed — resolve the triggering proposal's scope.
        triggering_id = rfc.get("triggering_proposal")
        if not triggering_id:
            continue
        proposal = queue_by_id.get(triggering_id)
        if proposal is None:
            continue

        proposal_scope: str = proposal.get("semantic_scope", "")

        # Only block when the agent's scope matches the RFC's scope.
        if proposal_scope != agent_scope:
            continue

        rfc_id = rfc.get("id", os.path.basename(rfc_path))
        print(
            f"SKL: Push blocked. RFC {rfc_id} response deadline passed "
            f"{raw_deadline}. Semantic scope '{agent_scope}' is paused until "
            f"this RFC is resolved."
        )
        print(
            "Resolve the RFC in VS Code using 'SKL: Resolve RFC' to continue."
        )
        return False

    return True


# ── Check 3 helpers: AST risk signal generation ─────────────────────

def get_file_content_at_ref(
    filepath: str, git_ref: str, repo_root: Optional[str] = None,
) -> Optional[str]:
    """
    Retrieve the content of *filepath* at *git_ref* via ``git show``.

    Returns the file content as a string, or ``None`` if the file did
    not exist at that ref (new file).
    """
    try:
        result = subprocess.run(
            ["git", "show", f"{git_ref}:{filepath}"],
            capture_output=True,
            text=True,
            cwd=repo_root,
        )
        if result.returncode != 0:
            return None
        return result.stdout
    except (OSError, subprocess.SubprocessError):
        return None


# ── Timing guard constant (milliseconds) ────────────────────────────
_AST_TIMEOUT_MS = 500


def _safe_parse(source: str) -> Optional[ast.Module]:
    """Parse Python source, returning None on any syntax error."""
    try:
        return ast.parse(source, type_comments=False)
    except SyntaxError:
        return None


def compute_mechanical_only(
    base_content: Optional[str], head_content: str,
) -> bool:
    """
    Check 3 helper — determine whether a diff is *mechanical-only*.

    Mechanical means the AST structure is unchanged, or the only
    differences are docstrings (``ast.Expr`` wrapping ``ast.Constant``)
    and ``ast.Pass`` nodes.

    Returns ``False`` as the safe default on parse failures, new files,
    or timeout (> 500 ms).
    """
    t0 = time.monotonic()

    # New file is never mechanical.
    if base_content is None:
        return False

    base_tree = _safe_parse(base_content)
    head_tree = _safe_parse(head_content)
    if base_tree is None or head_tree is None:
        return False

    # Strip cosmetic nodes (docstrings, bare constants, Pass) from
    # every statement list in the tree so that dumps become comparable.
    import copy as _copy

    def _strip_cosmetic(tree: ast.Module) -> ast.Module:
        """Return a deep copy with docstrings, bare Constants, and Pass removed."""
        tree = _copy.deepcopy(tree)
        for node in ast.walk(tree):
            for field, value in ast.iter_fields(node):
                if isinstance(value, list):
                    filtered: List[ast.AST] = []
                    for item in value:
                        if isinstance(item, ast.Pass):
                            continue
                        if (
                            isinstance(item, ast.Expr)
                            and isinstance(
                                getattr(item, "value", None), ast.Constant
                            )
                        ):
                            continue
                        filtered.append(item)
                    setattr(node, field, filtered)
        return tree

    base_stripped = _strip_cosmetic(base_tree)
    head_stripped = _strip_cosmetic(head_tree)

    # Fast path: identical AST dumps after stripping.
    if ast.dump(base_stripped) == ast.dump(head_stripped):
        elapsed_ms = (time.monotonic() - t0) * 1000
        if elapsed_ms > _AST_TIMEOUT_MS:
            print(
                f"SKL: Warning — AST mechanical-only check exceeded {_AST_TIMEOUT_MS}ms "
                f"({elapsed_ms:.0f}ms). Defaulting to non-mechanical.",
                file=sys.stderr,
            )
            return False
        return True

    base_nodes = ast.dump(base_stripped)
    head_nodes = ast.dump(head_stripped)

    elapsed_ms = (time.monotonic() - t0) * 1000
    if elapsed_ms > _AST_TIMEOUT_MS:
        print(
            f"SKL: Warning — AST mechanical-only check exceeded {_AST_TIMEOUT_MS}ms "
            f"({elapsed_ms:.0f}ms). Defaulting to non-mechanical.",
            file=sys.stderr,
        )
        return False

    return base_nodes == head_nodes


def _extract_top_level_defs(
    tree: ast.Module,
) -> Dict[str, ast.AST]:
    """Extract top-level function/class definitions as {name: node}."""
    defs: Dict[str, ast.AST] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defs[node.name] = node
    return defs


def _signature_key(node: ast.AST) -> Tuple[str, ...]:
    """
    Build a comparable signature tuple for a function or class node.

    For functions: (name, arg_names..., has_vararg, has_kwarg, #defaults, #kw_defaults)
    For classes:   (name,)
    """
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        args_obj = node.args
        arg_names = tuple(a.arg for a in args_obj.args)
        has_vararg = "*" if args_obj.vararg else ""
        has_kwarg = "**" if args_obj.kwarg else ""
        n_defaults = str(len(args_obj.defaults))
        kw_only_names = tuple(a.arg for a in args_obj.kwonlyargs)
        n_kw_defaults = str(
            sum(1 for d in args_obj.kw_defaults if d is not None)
        )
        return (
            node.name,
            *arg_names,
            has_vararg,
            has_kwarg,
            n_defaults,
            *kw_only_names,
            n_kw_defaults,
        )
    # ClassDef — only the name matters for this check.
    if isinstance(node, ast.ClassDef):
        return (node.name,)
    return ()


def compute_public_api_signature_changed(
    base_content: Optional[str], head_content: str,
) -> bool:
    """
    Check 3 helper — determine whether the public API surface changed.

    Compares top-level ``FunctionDef``, ``AsyncFunctionDef``, and
    ``ClassDef`` nodes between base and head. A change means a
    definition was added, removed, or had its signature altered.

    Returns ``True`` as the safe default for new files or parse failures.
    """
    # New file always introduces a public API.
    if base_content is None:
        return True

    base_tree = _safe_parse(base_content)
    head_tree = _safe_parse(head_content)
    if base_tree is None or head_tree is None:
        return True

    base_defs = _extract_top_level_defs(base_tree)
    head_defs = _extract_top_level_defs(head_tree)

    # Check for added or removed names.
    if set(base_defs.keys()) != set(head_defs.keys()):
        return True

    # Check for signature changes on surviving names.
    for name in base_defs:
        if _signature_key(base_defs[name]) != _signature_key(head_defs[name]):
            return True

    return False


def compute_auth_pattern_touched(
    head_content: str, security_patterns: List[str],
) -> bool:
    """
    Check 3 helper — detect whether *head_content* references any of the
    project's security patterns.

    Walks the entire AST and checks ``ast.Name.id``, ``ast.Attribute.attr``,
    and the resolved name of ``ast.Call.func`` against *security_patterns*
    using exact case-sensitive match.

    Returns ``False`` on parse failure (safe default — caller cannot confirm
    a match).
    """
    tree = _safe_parse(head_content)
    if tree is None:
        return False

    identifiers: List[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            identifiers.append(node.id)
        elif isinstance(node, ast.Attribute):
            identifiers.append(node.attr)
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name):
                identifiers.append(func.id)
            elif isinstance(func, ast.Attribute):
                identifiers.append(func.attr)

    for ident in identifiers:
        for pattern in security_patterns:
            if ident == pattern:
                return True
    return False


def _normalize_path(p: str) -> str:
    """Strip leading ``./`` and normalize separators."""
    return os.path.normpath(p)


def compute_invariant_referenced_file_modified(
    modified_filepath: str, state_records: List[Dict[str, Any]],
) -> bool:
    """
    Check 3 helper — True if any State record with non-empty
    ``invariants_touched`` lists *modified_filepath* in its
    ``dependencies``.
    """
    norm_modified = _normalize_path(modified_filepath)
    for record in state_records:
        invariants = record.get("invariants_touched", [])
        if not invariants:
            continue
        deps = record.get("dependencies", [])
        for dep in deps:
            if _normalize_path(dep) == norm_modified:
                return True
    return False


def compute_high_fan_in(
    modified_filepath: str, state_records: List[Dict[str, Any]],
) -> bool:
    """
    Check 3 helper — True if *modified_filepath* appears in the
    ``dependencies`` of >= ``HIGH_FAN_IN_THRESHOLD`` State records.
    """
    norm_modified = _normalize_path(modified_filepath)
    count = 0
    for record in state_records:
        deps = record.get("dependencies", [])
        for dep in deps:
            if _normalize_path(dep) == norm_modified:
                count += 1
                break  # only count each record once
    return count >= HIGH_FAN_IN_THRESHOLD


def derive_ast_change_type(
    mechanical_only: bool, public_api_signature_changed: bool,
) -> str:
    """
    Derive the ``ast_change_type`` vocabulary term.

    * ``"mechanical"`` — if *mechanical_only* is True (checked first).
    * ``"structural"`` — if *public_api_signature_changed* is True.
    * ``"behavioral"`` — otherwise.
    """
    if mechanical_only:
        return "mechanical"
    if public_api_signature_changed:
        return "structural"
    return "behavioral"


def build_risk_signals(
    base_content: Optional[str],
    head_content: str,
    filepath: str,
    state_records: List[Dict[str, Any]],
    security_patterns: List[str],
) -> Dict[str, Any]:
    """
    Orchestrate all risk-signal computations and return the complete
    ``risk_signals`` dict matching the ``RiskSignals`` TypeScript type.
    """
    mech = compute_mechanical_only(base_content, head_content)
    pub_api = compute_public_api_signature_changed(base_content, head_content)
    auth = compute_auth_pattern_touched(head_content, security_patterns)
    inv_ref = compute_invariant_referenced_file_modified(filepath, state_records)
    fan_in = compute_high_fan_in(filepath, state_records)
    change_type = derive_ast_change_type(mech, pub_api)

    # mechanical_only is True only when ast_change_type == "mechanical"
    # AND every other boolean signal is False.
    mechanical_only = (
        change_type == "mechanical"
        and not auth
        and not inv_ref
        and not fan_in
    )

    return {
        "touched_auth_or_permission_patterns": auth,
        "public_api_signature_changed": pub_api,
        "invariant_referenced_file_modified": inv_ref,
        "high_fan_in_module_modified": fan_in,
        "ast_change_type": change_type,
        "mechanical_only": mechanical_only,
    }


def extract_imports(head_content: str) -> List[str]:
    """
    Check 4 helper — extract all imported module names from *head_content*.

    * ``import foo.bar``  → ``"foo.bar"``
    * ``from app.utils import x``  → ``"app.utils"``
    * ``from . import x`` (relative, no module) → skipped

    Returns an empty list on parse failure.
    """
    tree = _safe_parse(head_content)
    if tree is None:
        return []

    modules: List[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module is not None:
                modules.append(node.module)
    return modules


def resolve_to_repo_path(
    module_str: str, repo_root: str,
) -> Optional[str]:
    """
    Check 4 helper — convert a dotted Python module string to a
    repo-relative file path.

    Checks ``<module_as_path>.py`` first, then ``<module_as_path>/__init__.py``.
    Returns ``None`` when neither exists (stdlib / third-party).
    """
    rel = module_str.replace(".", os.sep)

    # Try <module>.py
    candidate_py = os.path.normpath(os.path.join(repo_root, rel + ".py"))
    if os.path.isfile(candidate_py):
        return os.path.normpath(rel + ".py")

    # Try <module>/__init__.py
    candidate_init = os.path.normpath(
        os.path.join(repo_root, rel, "__init__.py")
    )
    if os.path.isfile(candidate_init):
        return os.path.normpath(os.path.join(rel, "__init__.py"))

    return None


def scan_imports(
    filepath: str, head_content: str, repo_root: str,
) -> List[str]:
    """
    Check 4 helper — return repo-relative paths for every project-internal
    import found in *head_content*.

    Chains :func:`extract_imports` → :func:`resolve_to_repo_path`, filtering
    out any ``None`` (stdlib / third-party) results.
    """
    raw_modules = extract_imports(head_content)
    resolved: List[str] = []
    for mod in raw_modules:
        repo_path = resolve_to_repo_path(mod, repo_root)
        if repo_path is not None:
            resolved.append(repo_path)
    return resolved


def validate_dependencies(
    scanned_imports: List[str],
    state_record: Optional[Dict[str, Any]],
    all_state_records: List[Dict[str, Any]],
    scope_definitions: Optional[Dict[str, Any]],
    agent_semantic_scope: str,
) -> Dict[str, Any]:
    """
    Check 4 — compare *scanned_imports* against declared dependencies
    in *state_record* and detect cross-scope undeclared imports.

    Returns ``{"undeclared_imports": [...], "stale_declared_deps": [...],
    "cross_scope_undeclared": [...]}``.
    """
    scanned_set: Set[str] = {_normalize_path(p) for p in scanned_imports}

    if state_record is not None:
        declared: Set[str] = {
            _normalize_path(d)
            for d in state_record.get("dependencies", [])
        }
        undeclared = sorted(scanned_set - declared)
        stale = sorted(declared - scanned_set)
    else:
        # New file — no existing record to compare against.
        undeclared = sorted(scanned_set)
        stale: List[str] = []

    # Build a mapping of normalised-path → semantic_scope from all records.
    path_to_scope: Dict[str, str] = {}
    for rec in all_state_records:
        rec_path = _normalize_path(rec.get("path", ""))
        rec_scope = rec.get("semantic_scope", "")
        if rec_path:
            path_to_scope[rec_path] = rec_scope

    # Known expected cross-scope imports (prefix-matching for entries
    # ending with "/").
    known_expected: List[str] = []
    if scope_definitions is not None:
        known_expected = scope_definitions.get(
            "known_expected_cross_scope_imports", []
        )

    def _is_known_expected(imp: str) -> bool:
        norm = _normalize_path(imp)
        for entry in known_expected:
            entry_path = entry if isinstance(entry, str) else entry.get("imported_path", "")
            if entry_path.endswith("/"):
                if norm.startswith(_normalize_path(entry_path.rstrip("/"))):
                    return True
            else:
                if norm == _normalize_path(entry_path):
                    return True
        return False

    cross_scope_undeclared: List[str] = []
    # Check all undeclared imports (for new files this is the full set).
    for imp in undeclared:
        imp_scope = path_to_scope.get(imp, "")
        if imp_scope and imp_scope != agent_semantic_scope:
            if not _is_known_expected(imp):
                cross_scope_undeclared.append(imp)

    return {
        "undeclared_imports": undeclared if state_record is not None else [],
        "stale_declared_deps": stale,
        "cross_scope_undeclared": cross_scope_undeclared,
    }


def build_proposal(
    agent_context: Dict[str, Any],
    filepath: str,
    out_of_scope: bool,
    cross_scope_flag: bool,
    risk_signals: Dict[str, Any],
    dependency_scan: Dict[str, Any],
    queue_length: int,
) -> Dict[str, Any]:
    """
    Assemble a complete QueueProposal dict for *filepath*.
    """
    now = datetime.now(timezone.utc)
    proposal_id = PROPOSAL_ID_FORMAT.format(
        date=now.strftime("%Y%m%d"),
        agent_id=agent_context["agent_id"],
        seq=queue_length + 1,
    )

    blocking_reasons: List[str] = []
    if dependency_scan.get("cross_scope_undeclared"):
        blocking_reasons.append("cross_scope_undeclared_dependency")

    return {
        "proposal_id": proposal_id,
        "agent_id": agent_context["agent_id"],
        "path": filepath,
        "semantic_scope": agent_context.get("semantic_scope", ""),
        "status": "pending",
        "submitted_at": now.strftime("%Y-%m-%dT%H:%M:%S") + "Z",
        "out_of_scope": out_of_scope,
        "cross_scope_flag": cross_scope_flag,
        "risk_signals": risk_signals,
        "dependency_scan": dependency_scan,
        "classification_verification": {
            "agent_classification": None,
            "verifier_classification": None,
            "agreement": None,
            "stage1_override": False,
        },
        "blocking_reasons": blocking_reasons,
    }


def atomic_write_knowledge(
    knowledge_path: str, knowledge: Dict[str, Any],
) -> None:
    """
    Atomically write *knowledge* to *knowledge_path* via
    temp-and-rename.  Exits with code 1 on failure.
    """
    tmp_path = knowledge_path + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(knowledge, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, knowledge_path)
    except OSError as exc:
        print(f"SKL: Failed to write knowledge.json — {exc}")
        sys.exit(1)


# ── Main ────────────────────────────────────────────────────────────

def main() -> None:
    # ── Startup ─────────────────────────────────────────────────
    script_path = os.path.abspath(__file__)
    repo_root = find_repo_root(os.path.dirname(script_path))
    if repo_root is None:
        print(
            "SKL: Could not locate repository root. Is this a git repository?"
        )
        sys.exit(1)

    skl_dir = os.path.join(repo_root, ".skl")

    config = load_hook_config(skl_dir)
    SKL_MODE: str = config.get("skl_mode", "full")
    PHASE_0_QUEUE_MAX = 50
    queue_max: int = (
        PHASE_0_QUEUE_MAX
        if SKL_MODE == "phase_0"
        else config.get("queue_max", DEFAULT_HOOK_CONFIG["queue_max"])
    )
    base_branch: str = config.get(
        "base_branch", DEFAULT_HOOK_CONFIG["base_branch"]
    )

    agent_id = os.environ.get("SKL_AGENT_ID")
    if not agent_id:
        print(
            "SKL: SKL_AGENT_ID environment variable is not set. "
            "Set it to your agent ID (e.g. export SKL_AGENT_ID=Agent-1) "
            "before pushing."
        )
        sys.exit(1)

    ctx_path = os.path.join(skl_dir, "scratch", f"{agent_id}_context.json")
    agent_context = read_json_file(ctx_path)
    if agent_context is None or not isinstance(agent_context, dict):
        print(
            f"SKL: No agent context found for {agent_id}. "
            "Run 'SKL: Configure Agent' in VSCode before pushing."
        )
        sys.exit(1)

    knowledge_path = os.path.join(skl_dir, "knowledge.json")
    knowledge = read_json_file(knowledge_path)
    if knowledge is None or not isinstance(knowledge, dict):
        print(
            "SKL: knowledge.json is missing or corrupt. "
            "Run 'SKL: Initialize Project' in VSCode."
        )
        sys.exit(1)

    scope_defs = read_json_file(
        os.path.join(skl_dir, "scope_definitions.json")
    )
    scope_entry: Optional[Dict[str, Any]] = None
    agent_semantic_scope: str = agent_context.get("semantic_scope", "")
    if scope_defs is None or not isinstance(scope_defs, dict):
        print(
            "SKL: scope_definitions.json not found — "
            "scope validation will be skipped."
        )
        scope_defs = None
    else:
        scopes = scope_defs.get("scope_definitions", {}).get("scopes", {})
        scope_entry = scopes.get(agent_semantic_scope)
        if scope_entry is None and agent_semantic_scope:
            print(
                f"SKL: Warning — agent scope '{agent_semantic_scope}' "
                "not found in scope_definitions.json. "
                "Scope validation will be skipped."
            )

    # ── Check 1: File Scope Validation ──────────────────────────
    modified_files = get_modified_files(repo_root, base_branch)
    if modified_files is None:
        print(
            f"SKL: Warning — could not run git diff against '{base_branch}'. "
            "Treating all modified files as in-scope."
        )
        modified_files = []

    file_scope: List[str] = agent_context.get("file_scope", [])
    violations = check_file_scope(modified_files, file_scope)

    out_of_scope_list = [v for v in violations.values() if v.out_of_scope]
    if out_of_scope_list:
        print(
            f"SKL: {len(out_of_scope_list)} file(s) outside agent file_scope — "
            "proposals will be flagged out_of_scope:"
        )
        for v in out_of_scope_list:
            print(f"  - {v.path}")

    # ── Check 2: Semantic Scope Validation ──────────────────────────
    if SKL_MODE == "full":
        violations = check_semantic_scope(violations, scope_entry)

        cross_scope_list = [v for v in violations.values() if v.cross_scope_flag]
        if cross_scope_list:
            print(
                f"SKL: {len(cross_scope_list)} file(s) cross semantic scope "
                "boundaries — proposals will be flagged cross_scope:"
            )
            for v in cross_scope_list:
                print(f"  - {v.path}")

    # ── Check 5: Queue Budget ───────────────────────────────────
    queue_error = check_queue_budget(knowledge, queue_max)
    if queue_error is not None:
        print(queue_error)
        sys.exit(1)
    # ── Check 6: Acceptance Criteria Gate ───────────────────────
    if SKL_MODE == "full":
        # Resolve the current branch; skip silently on any git failure.
        _current_branch: Optional[str] = None
        try:
            _cb = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                capture_output=True,
                text=True,
                cwd=repo_root,
            )
            if _cb.returncode == 0:
                _current_branch = _cb.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            pass

        if _current_branch is not None:
            rfcs_dir = os.path.join(skl_dir, "rfcs")
            if not check_acceptance_criteria(
                knowledge, agent_context, _current_branch, rfcs_dir
            ):
                sys.exit(1)

    # ── Check 7: RFC Scope Pause ─────────────────────────────────
    if SKL_MODE == "full":
        rfcs_dir = os.path.join(skl_dir, "rfcs")
        if not check_rfc_scope_pause(knowledge, agent_context, rfcs_dir):
            sys.exit(1)

    # ── Collect State records & security patterns ───────────────
    state_records: List[Dict[str, Any]] = knowledge.get("state", [])
    invariants = knowledge.get("invariants", {})
    security_patterns: List[str] = invariants.get("security_patterns", [])

    # Build a lookup of normalised path → state record.
    state_by_path: Dict[str, Dict[str, Any]] = {}
    for rec in state_records:
        rp = _normalize_path(rec.get("path", ""))
        if rp:
            state_by_path[rp] = rec

    current_queue: List[Dict[str, Any]] = knowledge.get("queue", [])
    queue_length = len(current_queue)

    proposals: List[Dict[str, Any]] = []

    for filepath in modified_files:
        viol = violations.get(filepath)
        is_oos = viol.out_of_scope if viol else False
        is_cs = viol.cross_scope_flag if viol else False

        # ── Check 3: Risk Signals (Python files only) ──────────
        is_py = filepath.endswith(".py")
        if is_py:
            base_content = get_file_content_at_ref(
                filepath, base_branch, repo_root
            )
            head_content = get_file_content_at_ref(
                filepath, "HEAD", repo_root
            )
            if head_content is None:
                head_content = ""
            risk_signals = build_risk_signals(
                base_content, head_content, filepath,
                state_records, security_patterns,
            )
        else:
            risk_signals = build_risk_signals(
                None, "", filepath, state_records, security_patterns,
            )

        # ── Check 4: Dependency Scan (Python files only) ───────
        if is_py and head_content:
            scanned = scan_imports(filepath, head_content, repo_root)
        else:
            scanned = []

        state_rec = state_by_path.get(_normalize_path(filepath))
        dep_scan = validate_dependencies(
            scanned, state_rec, state_records,
            scope_defs, agent_semantic_scope,
        )

        # ── Build proposal ─────────────────────────────────────
        proposal = build_proposal(
            agent_context, filepath, is_oos, is_cs,
            risk_signals, dep_scan, queue_length + len(proposals),
        )
        proposals.append(proposal)

    # ── Atomic write ────────────────────────────────────────────
    if proposals:
        current_queue.extend(proposals)
        knowledge["queue"] = current_queue
        atomic_write_knowledge(knowledge_path, knowledge)

    # ── Summary ─────────────────────────────────────────────────
    blocking = sum(
        1 for p in proposals if p.get("blocking_reasons")
    )
    if SKL_MODE == "phase_0":
        print(
            f"SKL Phase 0: {len(proposals)} activity record(s) logged. "
            f"Run 'SKL: View Activity' in VS Code to see what changed."
        )
    else:
        print(
            f"SKL: {len(proposals)} proposal(s) submitted to Queue. "
            f"{blocking} blocking flag(s)."
        )
    sys.exit(0)


if __name__ == "__main__":
    main()
