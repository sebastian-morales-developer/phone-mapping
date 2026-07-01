#!/usr/bin/env python3
"""Bulk edit property photos grouped by project folders."""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

from edit_house_image import DEFAULT_PROMPT, build_prompt, process_image


IMAGE_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".bmp",
    ".gif",
    ".tif",
    ".tiff",
}
COST_PER_IMAGE_USD = Decimal("0.175")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bulk process project image folders with OpenAI image editing."
    )
    parser.add_argument(
        "--input-root",
        type=Path,
        default=Path("PHOTO_REPORTS_CHOSEN"),
        help="Folder containing one subfolder per project.",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("outputs") / "outputs_bulks",
        help="Folder where timestamped bulk runs are saved.",
    )
    parser.add_argument(
        "--prompt",
        default=DEFAULT_PROMPT,
        help="Editing prompt. Defaults to removing facade obstructions.",
    )
    parser.add_argument(
        "--prompt-file",
        type=Path,
        help="Optional text file with the editing prompt. Overrides --prompt.",
    )
    parser.add_argument(
        "--model",
        default="gpt-image-2",
        help="OpenAI image model to use.",
    )
    parser.add_argument(
        "--size",
        default="1536x1024",
        help='Output size. Use "auto" or a supported size like 1536x1024.',
    )
    parser.add_argument(
        "--quality",
        default="high",
        choices=["low", "medium", "high", "auto"],
        help="Output quality.",
    )
    parser.add_argument(
        "--output-format",
        default="png",
        choices=["png", "jpeg", "webp"],
        help="Edited output file format.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the planned work without calling the API.",
    )
    parser.add_argument(
        "--stop-on-error",
        action="store_true",
        help="Stop the bulk run on the first failed image.",
    )
    return parser.parse_args()


def is_image_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS


def project_dirs(input_root: Path) -> list[Path]:
    return sorted(path for path in input_root.iterdir() if path.is_dir())


def project_images(project_dir: Path) -> list[Path]:
    return sorted(path for path in project_dir.rglob("*") if is_image_file(path))


def safe_output_stem(project_dir: Path, image_path: Path) -> str:
    relative = image_path.relative_to(project_dir)
    stem_parts = [*relative.parent.parts, relative.stem]
    return "__".join(part.replace(" ", "_") for part in stem_parts if part)


def run_folder_name() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def main() -> int:
    load_dotenv()
    args = parse_args()

    input_root = args.input_root.expanduser()
    if not input_root.is_dir():
        print(f"Input root not found: {input_root}", file=sys.stderr)
        return 1

    try:
        prompt = build_prompt(args.prompt, args.prompt_file)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    projects = project_dirs(input_root)
    if not projects:
        print(f"No project folders found in: {input_root}", file=sys.stderr)
        return 1

    bulk_dir = args.output_root.expanduser() / run_folder_name()
    planned_images = [(project, image) for project in projects for image in project_images(project)]

    if args.dry_run:
        estimated_total = len(planned_images) * COST_PER_IMAGE_USD
        estimated_total = estimated_total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        print(f"Bulk output folder: {bulk_dir}")
        print(f"Projects found: {len(projects)}")
        print(f"Images found: {len(planned_images)}")
        print(f"Estimated cost per image: ${COST_PER_IMAGE_USD}")
        print(f"Estimated total cost: ${estimated_total}")
        for project, image in planned_images:
            stem = safe_output_stem(project, image)
            print(f"[DRY RUN] {project.name}: {image} -> {stem}_edited.{args.output_format}", flush=True)
        return 0

    bulk_dir.mkdir(parents=True, exist_ok=True)
    client = OpenAI()

    total = len(planned_images)
    completed = 0
    failed = 0

    print(f"Bulk output folder: {bulk_dir}", flush=True)
    print(f"Projects found: {len(projects)}", flush=True)
    print(f"Images found: {total}", flush=True)

    for index, (project, image_path) in enumerate(planned_images, start=1):
        project_output = bulk_dir / project.name
        edited_dir = project_output / "edited"
        comparison_dir = project_output / "comparison"
        stem = safe_output_stem(project, image_path)
        edited_path = edited_dir / f"{stem}_edited.{args.output_format}"
        comparison_path = comparison_dir / f"{stem}_comparison.png"

        print(f"[{index}/{total}] Processing: {image_path}", flush=True)
        try:
            process_image(
                client=client,
                input_path=image_path,
                edited_path=edited_path,
                comparison_path=comparison_path,
                prompt=prompt,
                model=args.model,
                size=args.size,
                quality=args.quality,
                output_format=args.output_format,
            )
        except Exception as exc:
            failed += 1
            print(f"FAILED: {image_path}: {exc}", file=sys.stderr, flush=True)
            if args.stop_on_error:
                return 1
            continue

        completed += 1
        print(f"Edited: {edited_path}", flush=True)
        print(f"Comparison: {comparison_path}", flush=True)

    print(f"Done. Completed: {completed}. Failed: {failed}. Output: {bulk_dir}", flush=True)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
