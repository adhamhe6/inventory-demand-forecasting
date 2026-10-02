"""Regenerate requirements.lock (pinned runtime deps) from pyproject.toml.

    python scripts/lock_deps.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
    report = Path(tmp) / "report.json"
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "--dry-run", "--ignore-installed", "--report", str(report), str(root)],
        check=True,
    )
    data = json.loads(report.read_text())
pins = sorted(
    f"{i['metadata']['name'].lower()}=={i['metadata']['version']}"
    for i in data["install"]
    if i["metadata"]["name"].lower() != "inventory-demand-forecasting"
)
header = "# Pinned runtime dependencies resolved from pyproject.toml.\n# Regenerate with: python scripts/lock_deps.py\n"
(root / "requirements.lock").write_text(header + "\n".join(pins) + "\n")
print(f"pinned {len(pins)} packages")
