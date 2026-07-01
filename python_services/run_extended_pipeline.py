#!/usr/bin/env python3
"""Run the full web-app pipeline: GLB generation plus measurements."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv


APP_ROOT = Path(__file__).resolve().parents[1]
RUN_PIPELINE = APP_ROOT / "python_services" / "run_pipeline.py"
CREATE_ORTHOPHOTOS = APP_ROOT / "python_services" / "create_orthophotos.py"
CALCULATE_TOP_AREA = APP_ROOT / "python_services" / "calculate_top_area.py"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the full Phone Mapping web-app pipeline.")
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--model-provider", default="tencent", choices=["tencent", "hyper3d"])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-photo-edit", action="store_true")
    parser.add_argument("--skip-3d", action="store_true")
    parser.add_argument("--poll-interval", type=int, default=20)
    parser.add_argument("--timeout-minutes", type=int, default=30)
    return parser.parse_args()


def run_step(name: str, command: list[str]) -> None:
    print("", flush=True)
    print(f"=== Extended pipeline step: {name} ===", flush=True)
    print("Command: " + " ".join(command), flush=True)
    completed = subprocess.run(command, cwd=APP_ROOT, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"{name} failed with exit code {completed.returncode}.")
    print(f"=== Completed: {name} ===", flush=True)


def first_glb_path(project_dir: Path) -> Path:
    output_glb_dir = project_dir / "output_glb"
    matches = sorted(output_glb_dir.glob("*.glb"))
    if not matches:
        raise FileNotFoundError(f"No GLB file found in {output_glb_dir}")
    return matches[0]


def main() -> int:
    args = parse_args()
    load_dotenv(APP_ROOT / ".env", override=True)

    project_dir = args.project.expanduser().resolve()
    orthophotos_dir = project_dir / "output_photos" / "orthophotos"
    measurements_dir = project_dir / "measurements"
    orthophotos_dir.mkdir(parents=True, exist_ok=True)
    measurements_dir.mkdir(parents=True, exist_ok=True)

    print("Extended Phone Mapping pipeline started", flush=True)
    print(f"App root: {APP_ROOT}", flush=True)
    print(f"Project: {project_dir}", flush=True)

    base_command = [
        sys.executable,
        str(RUN_PIPELINE),
        "--project",
        str(project_dir),
        "--model-provider",
        args.model_provider,
        "--poll-interval",
        str(args.poll_interval),
        "--timeout-minutes",
        str(args.timeout_minutes),
    ]
    if args.dry_run:
        base_command.append("--dry-run")
    if args.skip_photo_edit:
        base_command.append("--skip-photo-edit")
    if args.skip_3d:
        base_command.append("--skip-3d")

    run_step("Base pipeline: photo edit and GLB generation", base_command)

    if args.dry_run or args.skip_3d:
        print("Skipping extended GLB-dependent steps because dry-run or --skip-3d is active.", flush=True)
        return 0

    glb_path = first_glb_path(project_dir)
    print(f"GLB selected for extended pipeline: {glb_path}", flush=True)

    run_step(
        "Create orthophotos, normalize dimensions, and calculate GLB dimensions",
        [
            sys.executable,
            str(CREATE_ORTHOPHOTOS),
            "--model",
            str(glb_path),
            "--output-dir",
            str(orthophotos_dir),
        ],
    )

    run_step(
        "Calculate top visible area",
        [
            sys.executable,
            str(CALCULATE_TOP_AREA),
            "--model",
            str(glb_path),
            "--output",
            str(measurements_dir / "top_visible_area.json"),
        ],
    )

    print("", flush=True)
    print("Extended Phone Mapping pipeline finished successfully", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - keep terminal logs explicit.
        print(f"Extended Phone Mapping pipeline failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
