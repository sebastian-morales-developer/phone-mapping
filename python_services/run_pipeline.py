#!/usr/bin/env python3
"""Run the existing Phone Mapping Python pipeline for a web-app project."""

from __future__ import annotations

import argparse
import runpy
import sys
from pathlib import Path

from dotenv import load_dotenv


APP_ROOT = Path(__file__).resolve().parents[1]
SERVICE_DIR = Path(__file__).resolve().parent
PIPELINE_SCRIPT = SERVICE_DIR / "project_pipeline.py"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Phone Mapping V1 project pipeline.")
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--model-provider", default="tencent", choices=["tencent", "hyper3d"])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-photo-edit", action="store_true")
    parser.add_argument("--skip-3d", action="store_true")
    parser.add_argument("--poll-interval", type=int, default=20)
    parser.add_argument("--timeout-minutes", type=int, default=30)
    parser.add_argument("--hyper3d-bang", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    env_path = APP_ROOT / ".env"
    load_dotenv(env_path, override=True)

    if not PIPELINE_SCRIPT.is_file():
        print(f"Pipeline script not found: {PIPELINE_SCRIPT}", file=sys.stderr, flush=True)
        return 1

    if str(SERVICE_DIR) not in sys.path:
        sys.path.insert(0, str(SERVICE_DIR))

    project_dir = args.project.expanduser().resolve()
    delegated_args = [
        str(PIPELINE_SCRIPT),
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
        delegated_args.append("--dry-run")
    if args.skip_photo_edit:
        delegated_args.append("--skip-photo-edit")
    if args.skip_3d:
        delegated_args.append("--skip-3d")
    if args.hyper3d_bang:
        delegated_args.append("--hyper3d-bang")

    print("Python microservice started", flush=True)
    print(f"App root: {APP_ROOT}", flush=True)
    print(f"Environment file: {env_path}", flush=True)
    print(f"Local pipeline: {PIPELINE_SCRIPT}", flush=True)
    print(f"Project: {project_dir}", flush=True)

    sys.argv = delegated_args
    try:
        runpy.run_path(str(PIPELINE_SCRIPT), run_name="__main__")
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 1
        print(f"Python microservice finished with code {code}", flush=True)
        return code

    print("Python microservice finished with code 0", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
