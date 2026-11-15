"""Stdlib syntax/capability lint; not a Python static type checker or OS sandbox."""
import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = Path(__file__).resolve().parent / "src" / "evidence_watcher"
ALLOWED = {"dataclasses", "datetime", "hashlib", "json", "re", "contextlib", "pathlib", "sqlite3", "tempfile", "math"}
errors = []
paths = sorted(PACKAGE.glob("*.py")) + sorted((ROOT / "tests" / "jira-evidence-watcher").glob("*.py"))
for path in paths:
    tree = ast.parse(path.read_text(), filename=path.name)
    if path.parent != PACKAGE:
        continue
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module]
            if isinstance(node, ast.ImportFrom) and node.level:
                if node.level != 1 or node.module not in {"model", "store", "simulation"}:
                    errors.append("unreviewed-local-import")
            elif any(name not in ALLOWED for name in names):
                errors.append("external-capability-import")
        if isinstance(node, ast.Name) and node.id in {"eval", "exec", "__import__", "breakpoint"}:
            errors.append("dynamic-execution")
        if isinstance(node, ast.Attribute) and node.attr in {"environ", "getenv", "popen", "system", "spawn", "socket"}:
            errors.append("external-capability-access")
if errors:
    raise SystemExit("offline capability check failed: " + ",".join(sorted(set(errors))))
print(f"Offline Python syntax/capability check: {len(paths)} files, 0 findings (not operational certification)")
