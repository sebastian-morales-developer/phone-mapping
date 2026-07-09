#!/usr/bin/env python3
"""Submit up to five ordered multi-view images to Hyper3D Rodin Gen-2.5."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from itertools import permutations
from math import factorial
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from requests import HTTPError
from dotenv import load_dotenv


RODIN_ENDPOINT = "https://api.hyper3d.com/api/v2/rodin"
BANG_ENDPOINT = "https://api.hyper3d.com/api/v2/bang"
STATUS_ENDPOINT = "https://api.hyper3d.com/api/v2/status"
DOWNLOAD_ENDPOINT = "https://api.hyper3d.com/api/v2/download"

COUNTER_CLOCKWISE_ORDER = [
    "front",
    "front-left",
    "left",
    "back-left",
    "back",
    "back-right",
    "right",
    "front-right",
]

CLOCKWISE_ORDER = [
    "front",
    "front-right",
    "right",
    "back-right",
    "back",
    "back-left",
    "left",
    "front-left",
]

COUNTER_CLOCKWISE_2_ORDER = [
    "front",
    "left",
    "back",
    "right",
    "front-left",
    "back-left",
    "back-right",
    "front-right",
]

CLOCKWISE_2_ORDER = [
    "front",
    "right",
    "back",
    "left",
    "front-right",
    "back-right",
    "back-left",
    "front-left",
]

DIRECTION_ORDERS = {
    "counter_clockwise": COUNTER_CLOCKWISE_ORDER,
    "clockwise": CLOCKWISE_ORDER,
    "counter_clockwise_2": COUNTER_CLOCKWISE_2_ORDER,
    "clockwise_2": CLOCKWISE_2_ORDER,
}

DIRECTION_LABELS = {
    "counter_clockwise": "counter-clockwise",
    "clockwise": "clockwise",
    "counter_clockwise_2": "counter-clockwise-2",
    "clockwise_2": "clockwise-2",
}

IMAGE_LABELS = {
    "front": "F",
    "front-left": "FL",
    "front-right": "FR",
    "left": "L",
    "right": "R",
    "back": "B",
    "back-left": "BL",
    "back-right": "BR",
    "up": "U",
    "down": "D",
    "unknown": "?",
}

DEFAULT_DIRECTIONS = ["counter_clockwise_2"]
ALL_DIRECTIONS = [
    "counter_clockwise",
    "clockwise",
    "counter_clockwise_2",
    "clockwise_2",
]
PERMUTATION_SEED_ORDER = COUNTER_CLOCKWISE_2_ORDER
PERMUTATION_REFERENCE_FILE = "permutation_orders.json"
PERMUTATION_DIRECTION_FLAGS = [
    "run_all_directions",
    "run_original_both_directions",
    "run_new_both_directions",
    "run_counter_clockwise",
    "run_clockwise",
    "run_counter_clockwise_2",
    "run_clockwise_2",
]
KNOWN_ANGLES = sorted(
    IMAGE_LABELS,
    key=len,
    reverse=True,
)

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a 3D GLB from a folder of ordered multi-view images."
    )
    parser.add_argument(
        "input_dir",
        type=Path,
        help="Folder containing selected images for one 3D object.",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("outputs") / "outputs_hyper3d" / "individuals",
        help="Root folder where downloaded Hyper3D results are saved.",
    )
    parser.add_argument(
        "--max-images",
        type=int,
        default=5,
        help="Maximum images to send to Hyper3D. Rodin Gen-2.5 supports up to 5.",
    )
    parser.add_argument("--tier", default="Gen-2.5-High")
    parser.add_argument("--mesh-mode", default="Raw", choices=["Raw", "Quad"])
    parser.add_argument("--geometry-file-format", default="glb")
    parser.add_argument("--material", default="PBR")
    parser.add_argument("--quality", default=None)
    parser.add_argument("--quality-override", default="500000")
    parser.add_argument("--texture-mode", default="high")
    parser.add_argument(
        "--geometry-instruct-mode",
        default="creative",
        choices=["faithful", "creative"],
    )
    parser.add_argument(
        "--prompt",
        default=None,
        help="Manual prompt override. If omitted, a view-aware prompt is generated automatically.",
    )
    add_direction_arguments(parser)
    parser.add_argument(
        "--all-permutations",
        dest="run_all_permutations",
        action="store_true",
        default=None,
        help="Create every possible order for the selected images. With 5 images this creates 120 models.",
    )
    parser.add_argument(
        "--no-all-permutations",
        dest="run_all_permutations",
        action="store_false",
        help="Disable the default permutation mode and use the selected direction flags instead.",
    )
    parser.add_argument(
        "--start-permutation",
        type=int,
        default=1,
        help="First permutation index to execute in all-permutations mode. Use 24 to resume after permutation 23.",
    )
    parser.add_argument("--preview-render", action="store_true", default=True)
    parser.add_argument("--no-preview-render", dest="preview_render", action="store_false")
    parser.add_argument("--hd-texture", action="store_true")
    parser.add_argument("--texture-delight", action="store_true")
    parser.add_argument("--poll-interval", type=int, default=20)
    parser.add_argument("--timeout-minutes", type=int, default=60)
    parser.add_argument(
        "--concurrency",
        type=int,
        default=10,
        help="Maximum simultaneous Hyper3D generations for all-permutations mode. Business plan limit is 10.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show selected order and request parameters without calling the API.",
    )
    return parser.parse_args()


def add_direction_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--counter-clockwise",
        dest="run_counter_clockwise",
        action="store_true",
        help="Create one model using the original counter-clockwise image order.",
    )
    parser.add_argument(
        "--clockwise",
        dest="run_clockwise",
        action="store_true",
        help="Create one model using the original clockwise image order.",
    )
    parser.add_argument(
        "--counter-clockwise-2",
        dest="run_counter_clockwise_2",
        action="store_true",
        help="Create one model using the alternate counter-clockwise-2 image order.",
    )
    parser.add_argument(
        "--clockwise-2",
        dest="run_clockwise_2",
        action="store_true",
        help="Create one model using the alternate clockwise-2 image order.",
    )
    parser.add_argument(
        "--both-directions",
        dest="run_original_both_directions",
        action="store_true",
        help="Create the two original models: counter-clockwise and clockwise.",
    )
    parser.add_argument(
        "--both-directions-2",
        dest="run_new_both_directions",
        action="store_true",
        help="Create the two alternate models: counter-clockwise-2 and clockwise-2.",
    )
    parser.add_argument(
        "--all-directions",
        dest="run_all_directions",
        action="store_true",
        help="Create all available direction variants.",
    )


def is_image_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS


def normalize_text(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[_\s]+", "-", value)
    value = re.sub(r"-+", "-", value)
    return value


def detect_angle(path: Path) -> str | None:
    normalized = normalize_text(path.stem)
    for angle in KNOWN_ANGLES:
        pattern = rf"(^|[^a-z0-9]){re.escape(angle)}([^a-z0-9]|$)"
        if re.search(pattern, normalized):
            return angle
    return None


def collect_images_by_angle(input_dir: Path) -> tuple[dict[str, Path], list[Path], dict[str, list[Path]]]:
    images_by_angle: dict[str, Path] = {}
    unknown: list[Path] = []
    duplicates: dict[str, list[Path]] = {}

    for image_path in sorted(path for path in input_dir.iterdir() if is_image_file(path)):
        angle = detect_angle(image_path)
        if not angle:
            unknown.append(image_path)
            continue
        if angle in images_by_angle:
            duplicates.setdefault(angle, [images_by_angle[angle]]).append(image_path)
            continue
        images_by_angle[angle] = image_path

    return images_by_angle, unknown, duplicates


def selected_images(
    input_dir: Path,
    max_images: int,
    angle_order: list[str],
) -> tuple[list[tuple[str, Path]], list[tuple[str, Path]], list[Path], dict[str, list[Path]]]:
    images_by_angle, unknown, duplicates = collect_images_by_angle(input_dir)
    ordered = [
        (angle, images_by_angle[angle])
        for angle in angle_order
        if angle in images_by_angle
    ]
    return ordered[:max_images], ordered[max_images:], unknown, duplicates


def build_permutation_orders(
    seed_images: list[tuple[str, Path]],
) -> list[dict[str, Any]]:
    orders = []
    for index, ordered_images in enumerate(permutations(seed_images), start=1):
        key = f"permutation_{index:03d}"
        orders.append(
            {
                "index": index,
                "key": key,
                "label": f"permutation ({index:03d})",
                "folder": key,
                "file_suffix": f"_({index:03d})",
                "angle_order": [angle for angle, _ in ordered_images],
                "files": [path.name for _, path in ordered_images],
                "ordered_images": list(ordered_images),
            }
        )
    return orders


def write_permutation_reference(
    run_dir: Path,
    input_dir: Path,
    seed_ordered_images: list[tuple[str, Path]],
    skipped_images: list[tuple[str, Path]],
    unknown_images: list[Path],
    duplicate_images: dict[str, list[Path]],
    permutation_orders: list[dict[str, Any]],
    run_orders: list[dict[str, Any]],
    start_permutation: int,
) -> Path:
    reference_path = run_dir / PERMUTATION_REFERENCE_FILE
    data = {
        "input_dir": str(input_dir),
        "seed_priority_order": PERMUTATION_SEED_ORDER,
        "seed_selected_images": [
            {"angle": angle, "path": str(path), "file": path.name}
            for angle, path in seed_ordered_images
        ],
        "skipped_images": [
            {"angle": angle, "path": str(path), "file": path.name}
            for angle, path in skipped_images
        ],
        "unknown_images": [str(path) for path in unknown_images],
        "duplicate_images": {
            angle: [str(path) for path in paths]
            for angle, paths in duplicate_images.items()
        },
        "permutation_count": len(permutation_orders),
        "run_start_permutation": start_permutation,
        "run_end_permutation": run_orders[-1]["index"] if run_orders else None,
        "run_permutation_count": len(run_orders),
        "run_permutation_keys": [item["key"] for item in run_orders],
        "permutations": [
            {
                "index": item["index"],
                "key": item["key"],
                "label": item["label"],
                "folder": item["folder"],
                "file_suffix": item["file_suffix"],
                "angle_order": item["angle_order"],
                "files": item["files"],
            }
            for item in permutation_orders
        ],
    }
    run_dir.mkdir(parents=True, exist_ok=True)
    reference_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return reference_path


def safe_folder_name(value: str) -> str:
    value = re.sub(r"[^\w.\-() ]+", "_", value)
    value = re.sub(r"\s+", "_", value.strip())
    return value[:120] or "hyper3d_run"


def build_output_dir_path(input_dir: Path, output_root: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    source_name = input_dir.parent.name if input_dir.name.lower() == "selected" else input_dir.name
    name = safe_folder_name(source_name)
    return output_root / f"{timestamp}_{name}"


def create_output_dir(input_dir: Path, output_root: Path) -> Path:
    output_dir = build_output_dir_path(input_dir, output_root)
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def build_auto_prompt(ordered_images: list[tuple[str, Path]], direction_label: str) -> str:
    view_lines = [
        f"{index}. {angle} view: {path.name}"
        for index, (angle, path) in enumerate(ordered_images, start=1)
    ]
    return (
        f"The uploaded images are ordered in {direction_label} direction as:\n"
        + "\n".join(view_lines)
        + "\n\n"
        "Treat these as labeled camera views of the same residential house exterior. "
        "Use each listed view assignment to align the facades, roof planes, wall volumes, "
        "windows, doors, garage volumes, corners, and architectural proportions into one "
        "coherent 3D model. Preserve the real structure shown in the images and avoid "
        "inventing extra facades, duplicate walls, distorted roofs, or mismatched window "
        "placements. The entire top of the residential structure must be covered by roof "
        "geometry. Do not leave empty holes, open voids, missing roof surfaces, or transparent "
        "gaps in any roof area, even when the roof is flat, low-slope, partially hidden, or "
        "only visible from oblique side views. Infer continuous roof planes where needed from "
        "the available facades. Generate a realistic, consistent exterior model."
    )


def resolve_prompt(
    args: argparse.Namespace,
    ordered_images: list[tuple[str, Path]],
    direction_label: str,
) -> str:
    if args.prompt:
        return args.prompt
    return build_auto_prompt(ordered_images, direction_label)


def image_labels_for(ordered_images: list[tuple[str, Path]]) -> list[str]:
    return [IMAGE_LABELS.get(angle, "?") for angle, _ in ordered_images]


def format_image_label_field(labels: list[str]) -> str:
    return json.dumps(labels)


def request_fields(
    args: argparse.Namespace,
    prompt: str,
    ordered_images: list[tuple[str, Path]],
) -> list[tuple[str, str]]:
    image_labels = image_labels_for(ordered_images)
    fields = [
        ("tier", args.tier),
        ("mesh_mode", args.mesh_mode),
        ("geometry_file_format", args.geometry_file_format),
        ("material", args.material),
        ("texture_mode", args.texture_mode),
        ("geometry_instruct_mode", args.geometry_instruct_mode),
        ("image_label", format_image_label_field(image_labels)),
        ("preview_render", str(args.preview_render).lower()),
        ("hd_texture", str(args.hd_texture).lower()),
        ("texture_delight", str(args.texture_delight).lower()),
    ]
    if args.quality:
        fields.append(("quality", args.quality))
    if args.quality_override:
        fields.append(("quality_override", str(args.quality_override)))
    fields.append(("prompt", prompt))
    return fields


def submit_generation(
    api_key: str,
    ordered_images: list[tuple[str, Path]],
    fields: list[tuple[str, str]],
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {api_key}"}
    open_files = []
    files = []
    try:
        for _, image_path in ordered_images:
            content_type = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
            handle = image_path.open("rb")
            open_files.append(handle)
            files.append(("images", (image_path.name, handle, content_type)))

        for key, value in fields:
            files.append((key, (None, value)))

        response = requests.post(
            RODIN_ENDPOINT,
            headers=headers,
            files=files,
            timeout=120,
        )
        try:
            response.raise_for_status()
        except HTTPError as exc:
            body = response.text.strip()
            if body:
                raise RuntimeError(
                    f"{exc}; response body: {body[:2000]}"
                ) from exc
            raise
        data = response.json()
    finally:
        for handle in open_files:
            handle.close()

    if data.get("error"):
        raise RuntimeError(f"Hyper3D generation error: {data}")
    return data


def submit_bang(
    api_key: str,
    asset_id: str,
    strength: int = 5,
    geometry_file_format: str = "glb",
    material: str = "PBR",
    resolution: str = "Basic",
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {api_key}"}
    files = [
        ("asset_id", (None, asset_id)),
        ("strength", (None, str(strength))),
        ("geometry_file_format", (None, geometry_file_format)),
        ("material", (None, material)),
        ("resolution", (None, resolution)),
    ]
    response = requests.post(
        BANG_ENDPOINT,
        headers=headers,
        files=files,
        timeout=120,
    )
    try:
        response.raise_for_status()
    except HTTPError as exc:
        body = response.text.strip()
        if body:
            raise RuntimeError(f"{exc}; response body: {body[:2000]}") from exc
        raise
    data = response.json()
    if data.get("error"):
        raise RuntimeError(f"Hyper3D Bang error: {data}")
    return data


def check_status(api_key: str, subscription_key: str) -> dict[str, Any]:
    headers = {
        "accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    response = requests.post(
        STATUS_ENDPOINT,
        headers=headers,
        json={"subscription_key": subscription_key},
        timeout=60,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("error"):
        raise RuntimeError(f"Hyper3D status error: {data}")
    return data


def check_status_by_task_uuid(api_key: str, task_uuid: str) -> dict[str, Any]:
    headers = {
        "accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    response = requests.post(
        STATUS_ENDPOINT,
        headers=headers,
        json={"task_uuid": task_uuid},
        timeout=60,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("error"):
        raise RuntimeError(f"Hyper3D status error: {data}")
    return data


def wait_until_done_by_task_uuid(
    api_key: str,
    task_uuid: str,
    poll_interval: int,
    timeout_minutes: int,
    output_dir: Path,
    history_file_name: str = "status_history.json",
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_minutes * 60
    history = []

    while True:
        status_data = check_status_by_task_uuid(api_key, task_uuid)
        history.append(status_data)
        (output_dir / history_file_name).write_text(
            json.dumps(history, indent=2),
            encoding="utf-8",
        )

        statuses = [job.get("status") for job in status_data.get("jobs", [])]
        print(f"Status: {', '.join(statuses) or 'Unknown'}", flush=True)

        if statuses and all(status == "Done" for status in statuses):
            return status_data
        if any(status == "Failed" for status in statuses):
            raise RuntimeError(f"Hyper3D task failed: {status_data}")
        if time.monotonic() > deadline:
            raise TimeoutError(f"Timed out after {timeout_minutes} minutes.")

        time.sleep(poll_interval)


def wait_until_done(
    api_key: str,
    subscription_key: str,
    poll_interval: int,
    timeout_minutes: int,
    output_dir: Path,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_minutes * 60
    history = []

    while True:
        status_data = check_status(api_key, subscription_key)
        history.append(status_data)
        (output_dir / "status_history.json").write_text(
            json.dumps(history, indent=2),
            encoding="utf-8",
        )

        statuses = [job.get("status") for job in status_data.get("jobs", [])]
        print(f"Status: {', '.join(statuses) or 'Unknown'}", flush=True)

        if statuses and all(status == "Done" for status in statuses):
            return status_data
        if any(status == "Failed" for status in statuses):
            raise RuntimeError(f"Hyper3D generation failed: {status_data}")
        if time.monotonic() > deadline:
            raise TimeoutError(f"Timed out after {timeout_minutes} minutes.")

        time.sleep(poll_interval)


def download_result_list(api_key: str, task_uuid: str) -> dict[str, Any]:
    headers = {
        "accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    response = requests.post(
        DOWNLOAD_ENDPOINT,
        headers=headers,
        json={"task_uuid": task_uuid},
        timeout=60,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("error"):
        raise RuntimeError(f"Hyper3D download-list error: {data}")
    return data


def filename_from_download_item(item: dict[str, Any]) -> str:
    name = item.get("name")
    if name:
        return Path(name).name
    parsed = urlparse(item["url"])
    return Path(parsed.path).name or "hyper3d_result"


def append_filename_suffix(file_name: str, file_suffix: str | None) -> str:
    if not file_suffix:
        return file_name
    path = Path(file_name)
    return f"{path.stem}{file_suffix}{path.suffix}"


def download_files(
    download_data: dict[str, Any],
    output_dir: Path,
    file_suffix: str | None = None,
) -> list[Path]:
    downloaded: list[Path] = []
    for item in download_data.get("list", []):
        url = item.get("url")
        if not url:
            continue
        file_name = append_filename_suffix(filename_from_download_item(item), file_suffix)
        target_path = output_dir / file_name
        response = requests.get(url, timeout=300)
        response.raise_for_status()
        target_path.write_bytes(response.content)
        downloaded.append(target_path)
    return downloaded


def write_manifest(
    output_dir: Path,
    input_dir: Path,
    direction: str,
    angle_order: list[str],
    ordered_images: list[tuple[str, Path]],
    skipped_images: list[tuple[str, Path]],
    unknown_images: list[Path],
    duplicate_images: dict[str, list[Path]],
    fields: list[tuple[str, str]],
    prompt: str,
    generation_response: dict[str, Any] | None = None,
    download_response: dict[str, Any] | None = None,
    downloaded_files: list[Path] | None = None,
) -> None:
    manifest = {
        "input_dir": str(input_dir),
        "direction": direction,
        "angle_order": angle_order,
        "selected_images": [
            {"angle": angle, "path": str(path)}
            for angle, path in ordered_images
        ],
        "skipped_images": [
            {"angle": angle, "path": str(path)}
            for angle, path in skipped_images
        ],
        "unknown_images": [str(path) for path in unknown_images],
        "duplicate_images": {
            angle: [str(path) for path in paths]
            for angle, paths in duplicate_images.items()
        },
        "request_fields": dict(fields),
        "prompt": prompt,
        "generation_response": generation_response,
        "download_response": download_response,
        "downloaded_files": [str(path) for path in downloaded_files or []],
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )


def print_selection(
    direction_label: str,
    ordered_images: list[tuple[str, Path]],
    skipped_images: list[tuple[str, Path]],
    unknown_images: list[Path],
    duplicate_images: dict[str, list[Path]],
) -> None:
    print(f"{direction_label.title()} upload order:")
    for index, (angle, path) in enumerate(ordered_images, start=1):
        print(f"  {index}. {angle}: {path}")

    if skipped_images:
        print("Skipped because max image count was reached:")
        for angle, path in skipped_images:
            print(f"  - {angle}: {path}")

    if unknown_images:
        print("Ignored files without a known angle in the name:")
        for path in unknown_images:
            print(f"  - {path}")

    if duplicate_images:
        print("Duplicate angle files ignored after the first match:")
        for angle, paths in duplicate_images.items():
            print(f"  - {angle}: {', '.join(str(path) for path in paths[1:])}")


def directions_to_run(args: argparse.Namespace) -> list[str]:
    if getattr(args, "run_all_directions", False):
        return ALL_DIRECTIONS

    selected: list[str] = []
    if getattr(args, "run_original_both_directions", False):
        selected.extend(["counter_clockwise", "clockwise"])
    if getattr(args, "run_new_both_directions", False):
        selected.extend(["counter_clockwise_2", "clockwise_2"])
    if getattr(args, "run_counter_clockwise", False):
        selected.append("counter_clockwise")
    if getattr(args, "run_clockwise", False):
        selected.append("clockwise")
    if getattr(args, "run_counter_clockwise_2", False):
        selected.append("counter_clockwise_2")
    if getattr(args, "run_clockwise_2", False):
        selected.append("clockwise_2")

    if not selected and hasattr(args, "direction"):
        if args.direction == "both":
            selected.extend(["counter_clockwise", "clockwise"])
        elif args.direction:
            selected.append(args.direction)

    if not selected:
        selected.extend(DEFAULT_DIRECTIONS)

    return list(dict.fromkeys(selected))


def process_selected_order(
    args: argparse.Namespace,
    api_key: str | None,
    input_dir: Path,
    run_dir: Path,
    direction: str,
    direction_label: str,
    angle_order: list[str],
    ordered_images: list[tuple[str, Path]],
    skipped_images: list[tuple[str, Path]],
    unknown_images: list[Path],
    duplicate_images: dict[str, list[Path]],
    file_suffix: str | None = None,
) -> int:
    if not ordered_images:
        print(f"No usable angle-named images were found for {direction_label}.", file=sys.stderr)
        return 1

    prompt = resolve_prompt(args, ordered_images, direction_label)
    fields = request_fields(args, prompt, ordered_images)
    image_labels = image_labels_for(ordered_images)
    output_dir = run_dir / direction

    print("")
    print(f"Direction: {direction_label}")
    print(f"Output folder: {output_dir}")
    print_selection(
        direction_label,
        ordered_images,
        skipped_images,
        unknown_images,
        duplicate_images,
    )
    print(f"Images selected: {len(ordered_images)}")
    print(f"Image labels: {format_image_label_field(image_labels)}")
    print("Prompt:")
    print(prompt)

    if args.dry_run:
        print("Dry run only. No API request was sent.")
        return 0

    if not api_key:
        print("Missing HYPER3D_API_KEY in environment or .env.", file=sys.stderr)
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    write_manifest(
        output_dir=output_dir,
        input_dir=input_dir,
        direction=direction,
        angle_order=angle_order,
        ordered_images=ordered_images,
        skipped_images=skipped_images,
        unknown_images=unknown_images,
        duplicate_images=duplicate_images,
        fields=fields,
        prompt=prompt,
    )

    try:
        generation_response = submit_generation(api_key, ordered_images, fields)
        (output_dir / "generation_response.json").write_text(
            json.dumps(generation_response, indent=2),
            encoding="utf-8",
        )

        task_uuid = generation_response.get("uuid")
        subscription_key = generation_response.get("jobs", {}).get("subscription_key")
        if not task_uuid or not subscription_key:
            raise RuntimeError(f"Missing uuid or subscription_key: {generation_response}")

        print(f"Task UUID: {task_uuid}", flush=True)
        print(f"Subscription key: {subscription_key}", flush=True)
        wait_until_done(
            api_key=api_key,
            subscription_key=subscription_key,
            poll_interval=args.poll_interval,
            timeout_minutes=args.timeout_minutes,
            output_dir=output_dir,
        )

        download_response = download_result_list(api_key, task_uuid)
        (output_dir / "download_response.json").write_text(
            json.dumps(download_response, indent=2),
            encoding="utf-8",
        )
        downloaded_files = download_files(download_response, output_dir, file_suffix=file_suffix)
        write_manifest(
            output_dir=output_dir,
            input_dir=input_dir,
            direction=direction,
            angle_order=angle_order,
            ordered_images=ordered_images,
            skipped_images=skipped_images,
            unknown_images=unknown_images,
            duplicate_images=duplicate_images,
            fields=fields,
            prompt=prompt,
            generation_response=generation_response,
            download_response=download_response,
            downloaded_files=downloaded_files,
        )
    except Exception as exc:
        print(f"Hyper3D processing failed for {direction_label}: {exc}", file=sys.stderr)
        return 1

    glb_files = [path for path in downloaded_files if path.suffix.lower() == ".glb"]
    if glb_files:
        print("GLB files:")
        for path in glb_files:
            print(f"  {path}")
    else:
        print("No .glb file was found in the downloaded result list.", file=sys.stderr)
        print(f"Downloaded files: {', '.join(str(path) for path in downloaded_files)}")
        return 1

    return 0


def process_direction(
    args: argparse.Namespace,
    api_key: str | None,
    input_dir: Path,
    run_dir: Path,
    direction: str,
) -> int:
    angle_order = DIRECTION_ORDERS[direction]
    ordered_images, skipped_images, unknown_images, duplicate_images = selected_images(
        input_dir=input_dir,
        max_images=args.max_images,
        angle_order=angle_order,
    )
    return process_selected_order(
        args=args,
        api_key=api_key,
        input_dir=input_dir,
        run_dir=run_dir,
        direction=direction,
        direction_label=DIRECTION_LABELS[direction],
        angle_order=angle_order,
        ordered_images=ordered_images,
        skipped_images=skipped_images,
        unknown_images=unknown_images,
        duplicate_images=duplicate_images,
    )


def process_all_permutations(
    args: argparse.Namespace,
    api_key: str | None,
    input_dir: Path,
    run_dir: Path,
) -> int:
    seed_ordered_images, skipped_images, unknown_images, duplicate_images = selected_images(
        input_dir=input_dir,
        max_images=args.max_images,
        angle_order=PERMUTATION_SEED_ORDER,
    )

    if len(seed_ordered_images) != args.max_images:
        print(
            f"All-permutations mode requires exactly {args.max_images} usable images; "
            f"found {len(seed_ordered_images)}.",
            file=sys.stderr,
        )
        print_selection(
            "permutation seed",
            seed_ordered_images,
            skipped_images,
            unknown_images,
            duplicate_images,
        )
        return 1

    permutation_orders = build_permutation_orders(seed_ordered_images)
    run_orders = [
        item for item in permutation_orders
        if item["index"] >= args.start_permutation
    ]
    reference_path = write_permutation_reference(
        run_dir=run_dir,
        input_dir=input_dir,
        seed_ordered_images=seed_ordered_images,
        skipped_images=skipped_images,
        unknown_images=unknown_images,
        duplicate_images=duplicate_images,
        permutation_orders=permutation_orders,
        run_orders=run_orders,
        start_permutation=args.start_permutation,
    )

    print(f"Permutation reference: {reference_path}")
    print(f"Permutation seed images: {len(seed_ordered_images)}")
    print(f"Permutation orders available: {len(permutation_orders)}")
    print(f"Starting permutation: {args.start_permutation}")
    print(f"Permutation orders to run: {len(run_orders)}")
    print(f"Concurrency: {args.concurrency}")

    def run_permutation(item: dict[str, Any]) -> int:
        return process_selected_order(
            args=args,
            api_key=api_key,
            input_dir=input_dir,
            run_dir=run_dir,
            direction=item["key"],
            direction_label=item["label"],
            angle_order=item["angle_order"],
            ordered_images=item["ordered_images"],
            skipped_images=[],
            unknown_images=unknown_images,
            duplicate_images=duplicate_images,
            file_suffix=item["file_suffix"],
        )

    if args.dry_run or args.concurrency == 1:
        results = [run_permutation(item) for item in run_orders]
        return 0 if all(result == 0 for result in results) else 1

    results = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        future_to_key = {
            executor.submit(run_permutation, item): item["key"]
            for item in run_orders
        }
        for future in as_completed(future_to_key):
            key = future_to_key[future]
            try:
                result = future.result()
            except Exception as exc:
                print(f"Permutation {key} failed unexpectedly: {exc}", file=sys.stderr)
                result = 1
            print(f"Finished {key} with exit code {result}", flush=True)
            results.append(result)

    return 0 if all(result == 0 for result in results) else 1


def has_direction_flag(args: argparse.Namespace) -> bool:
    return any(getattr(args, flag, False) for flag in PERMUTATION_DIRECTION_FLAGS)


def should_run_all_permutations(args: argparse.Namespace) -> bool:
    return bool(args.run_all_permutations)


def main() -> int:
    load_dotenv()
    args = parse_args()

    input_dir = args.input_dir.expanduser()
    if not input_dir.is_dir():
        print(f"Input folder not found: {input_dir}", file=sys.stderr)
        return 1
    if args.max_images < 1 or args.max_images > 5:
        print("--max-images must be between 1 and 5.", file=sys.stderr)
        return 1
    if args.concurrency < 1 or args.concurrency > 10:
        print("--concurrency must be between 1 and 10 for the current Business plan.", file=sys.stderr)
        return 1
    max_permutation_index = factorial(args.max_images)
    if args.start_permutation < 1 or args.start_permutation > max_permutation_index:
        print(
            f"--start-permutation must be between 1 and {max_permutation_index}.",
            file=sys.stderr,
        )
        return 1

    output_root = args.output_root.expanduser()
    run_dir = build_output_dir_path(input_dir, output_root)
    api_key = None if args.dry_run else os.getenv("HYPER3D_API_KEY")

    print(f"Run output folder: {run_dir}")
    if should_run_all_permutations(args):
        print("Mode selected: all permutations")
        print(f"Expected permutation count: {args.max_images}! = {factorial(args.max_images)}")
        return process_all_permutations(args, api_key, input_dir, run_dir)

    selected_directions = directions_to_run(args)
    print(f"Directions selected: {', '.join(DIRECTION_LABELS[item] for item in selected_directions)}")
    results = [
        process_direction(args, api_key, input_dir, run_dir, direction)
        for direction in selected_directions
    ]
    return 0 if all(result == 0 for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
