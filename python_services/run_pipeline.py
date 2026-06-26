#!/usr/bin/env python3
"""Run the existing Phone Mapping Python pipeline for a web-app project."""

from __future__ import annotations

import argparse
import os
import runpy
import sys
from pathlib import Path

from dotenv import load_dotenv


APP_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_REPO = Path("/home/usuario/projects/phone_mapping_v1")
DEFAULT_PIPELINE_SCRIPT = DEFAULT_SOURCE_REPO / "web_app" / "phone_mapping_v1" / "phone_mapping_v1.py"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Phone Mapping V1 project pipeline.")
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-photo-edit", action="store_true")
    parser.add_argument("--skip-3d", action="store_true")
    parser.add_argument("--poll-interval", type=int, default=20)
    parser.add_argument("--timeout-minutes", type=int, default=30)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    env_path = APP_ROOT / ".env"
    load_dotenv(env_path, override=True)

    source_repo = Path(os.getenv("PHONE_MAPPING_SOURCE_REPO", str(DEFAULT_SOURCE_REPO))).expanduser()
    pipeline_script = Path(
        os.getenv("PHONE_MAPPING_PIPELINE_SCRIPT", str(DEFAULT_PIPELINE_SCRIPT))
    ).expanduser()

    if not pipeline_script.is_file():
        print(f"Pipeline script not found: {pipeline_script}", file=sys.stderr, flush=True)
        return 1

    if str(source_repo) not in sys.path:
        sys.path.insert(0, str(source_repo))

    project_dir = args.project.expanduser().resolve()
    delegated_args = [
        str(pipeline_script),
        "--project",
        str(project_dir),
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

    print("Python microservice started", flush=True)
    print(f"App root: {APP_ROOT}", flush=True)
    print(f"Environment file: {env_path}", flush=True)
    print(f"Delegated pipeline: {pipeline_script}", flush=True)
    print(f"Project: {project_dir}", flush=True)

    sys.argv = delegated_args
    try:
        runpy.run_path(str(pipeline_script), run_name="__main__")
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 1
        print(f"Python microservice finished with code {code}", flush=True)
        return code

    print("Python microservice finished with code 0", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
