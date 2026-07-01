#!/usr/bin/env python3
"""Generate a GLB with 3D AI Studio Tencent Hunyuan Pro multi-view images."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from PIL import Image


GENERATE_PRO_ENDPOINT = "https://api.3daistudio.com/v1/3d-models/tencent/generate/pro/"
STATUS_ENDPOINT_TEMPLATE = "https://api.3daistudio.com/v1/generation-request/{task_id}/status/"

VIEW_TYPES_BY_MODEL = {
    "3.0": ["front", "left", "right", "back"],
    "3.1": [
        "front",
        "left",
        "right",
        "back",
        "top",
        "bottom",
        "left_front",
        "right_front",
    ],
}

VIEW_UPLOAD_ORDER_31 = [
    "front",
    "left_front",
    "left",
    "back",
    "right",
    "right_front",
    "top",
    "bottom",
]

IMAGE_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
}


def parse_args(default_model: str = "3.0") -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Submit labeled multi-view images to 3D AI Studio Tencent Hunyuan Pro."
    )
    parser.add_argument(
        "input_dir",
        type=Path,
        help="Folder containing view-named images such as front.png and left_front.png.",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("outputs") / "outputs_3daistudio" / "individuals",
        help="Root folder where GLB results and metadata are saved.",
    )
    parser.add_argument("--model", default=default_model, choices=["3.0", "3.1"])
    parser.add_argument("--enable-pbr", action="store_true", help="Enable PBR textures (+20 credits).")
    parser.add_argument("--face-count", type=int, default=None)
    parser.add_argument("--generate-type", default=None)
    parser.add_argument("--prompt", default=None)
    parser.add_argument("--jpeg-quality", type=int, default=90)
    parser.add_argument(
        "--max-image-side",
        type=int,
        default=1536,
        help="Resize images so the longest side is at most this many pixels before upload.",
    )
    parser.add_argument(
        "--include-primary-image",
        action="store_true",
        help="Also send the front image in the top-level image field.",
    )
    parser.add_argument("--poll-interval", type=int, default=20)
    parser.add_argument("--timeout-minutes", type=int, default=30)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show detected views and payload summary without calling the API.",
    )
    return parser.parse_args()


def is_image_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS


def normalize_view_text(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[-\s]+", "_", value)
    value = re.sub(r"_+", "_", value)
    return value


def detect_view_type(path: Path, allowed_views: list[str]) -> str | None:
    normalized = normalize_view_text(path.stem)
    for view_type in sorted(allowed_views, key=len, reverse=True):
        pattern = rf"(^|[^a-z0-9]){re.escape(view_type)}([^a-z0-9]|$)"
        if re.search(pattern, normalized):
            return view_type
    return None


def upload_order_for_model(model: str) -> list[str]:
    if model == "3.1":
        return VIEW_UPLOAD_ORDER_31
    return VIEW_TYPES_BY_MODEL["3.0"]


def collect_images_by_view(input_dir: Path, model: str) -> tuple[list[tuple[str, Path]], list[Path], dict[str, list[Path]]]:
    allowed_views = VIEW_TYPES_BY_MODEL[model]
    images_by_view: dict[str, Path] = {}
    duplicates: dict[str, list[Path]] = {}
    unknown: list[Path] = []

    for image_path in sorted(path for path in input_dir.iterdir() if is_image_file(path)):
        view_type = detect_view_type(image_path, allowed_views)
        if not view_type:
            unknown.append(image_path)
            continue
        if view_type in images_by_view:
            duplicates.setdefault(view_type, [images_by_view[view_type]]).append(image_path)
            continue
        images_by_view[view_type] = image_path

    ordered = [
        (view_type, images_by_view[view_type])
        for view_type in upload_order_for_model(model)
        if view_type in images_by_view
    ]
    return ordered, unknown, duplicates


def image_to_data_uri(path: Path, max_side: int, jpeg_quality: int) -> str:
    with Image.open(path) as image:
        image = image.convert("RGB")
        if max_side and max(image.size) > max_side:
            image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)

        from io import BytesIO

        buffer = BytesIO()
        image.save(
            buffer,
            format="JPEG",
            quality=jpeg_quality,
            optimize=True,
        )

    image_base64 = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{image_base64}"


def safe_folder_name(value: str) -> str:
    value = re.sub(r"[^\w.\-() ]+", "_", value)
    value = re.sub(r"\s+", "_", value.strip())
    return value[:120] or "tencent_hunyuan_run"


def build_output_dir_path(input_dir: Path, output_root: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    source_name = input_dir.parent.name if input_dir.name.lower().startswith("selected") else input_dir.name
    return output_root / f"{timestamp}_{safe_folder_name(source_name)}"


def build_payload(args: argparse.Namespace, ordered_images: list[tuple[str, Path]]) -> dict[str, Any]:
    front_image = next(
        (image_path for view_type, image_path in ordered_images if view_type == "front"),
        None,
    )
    payload: dict[str, Any] = {
        "model": args.model,
        "enable_pbr": args.enable_pbr,
        "multi_view_images": [
            {
                "view_type": view_type,
                "view_image": image_to_data_uri(
                    image_path,
                    max_side=args.max_image_side,
                    jpeg_quality=args.jpeg_quality,
                ),
            }
            for view_type, image_path in ordered_images
        ],
    }
    if front_image is not None and args.include_primary_image:
        payload["image"] = image_to_data_uri(
            front_image,
            max_side=args.max_image_side,
            jpeg_quality=args.jpeg_quality,
        )
    if args.face_count is not None:
        payload["face_count"] = args.face_count
    if args.generate_type:
        payload["generate_type"] = args.generate_type
    if args.prompt:
        payload["prompt"] = args.prompt
    return payload


def payload_summary(payload: dict[str, Any]) -> dict[str, Any]:
    summary = dict(payload)
    if "image" in summary:
        summary["image"] = summary["image"].split(",", 1)[0] + ",<base64 omitted>"
    summary["multi_view_images"] = [
        {
            "view_type": item["view_type"],
            "view_image": item["view_image"].split(",", 1)[0] + ",<base64 omitted>",
        }
        for item in payload.get("multi_view_images", [])
    ]
    return summary


def submit_generation_with_log(
    api_key: str,
    payload: dict[str, Any],
    output_dir: Path,
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    attempts = []
    last_response: requests.Response | None = None

    for attempt in range(1, 7):
        response = requests.post(
            GENERATE_PRO_ENDPOINT,
            headers=headers,
            json=payload,
            timeout=120,
        )
        last_response = response
        attempt_log = {
            "attempt": attempt,
            "status_code": response.status_code,
            "response_headers": dict(response.headers),
            "response_text": response.text[:4000],
        }
        attempts.append(attempt_log)
        (output_dir / "submit_attempts.json").write_text(
            json.dumps(attempts, indent=2),
            encoding="utf-8",
        )

        if response.status_code not in {429, 502, 503, 504}:
            break

        wait_seconds = retry_wait_seconds(response, attempt)
        attempt_log["wait_seconds"] = wait_seconds
        (output_dir / "submit_attempts.json").write_text(
            json.dumps(attempts, indent=2),
            encoding="utf-8",
        )
        print(
            f"Generation endpoint returned HTTP {response.status_code}. "
            f"Retrying in {wait_seconds}s ({attempt}/6)...",
            flush=True,
        )
        time.sleep(wait_seconds)

    if last_response is None:
        raise RuntimeError("No response received from generation endpoint.")
    if last_response.status_code >= 400:
        raise RuntimeError(
            f"HTTP {last_response.status_code} from generation endpoint: "
            f"{last_response.text[:2000]}"
        )
    return last_response.json()


def retry_wait_seconds(response: requests.Response, attempt: int) -> int:
    retry_after = response.headers.get("Retry-After")
    if retry_after and retry_after.isdigit():
        return max(1, int(retry_after))

    try:
        error_data = response.json()
    except ValueError:
        error_data = {}

    message = str(error_data.get("error") or "")
    match = re.search(r"available in (\d+) seconds", message, re.IGNORECASE)
    if match:
        return int(match.group(1)) + 5

    if response.status_code == 429:
        return 45
    return attempt * 30


def check_status(api_key: str, task_id: str) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {api_key}"}
    response = requests.get(
        STATUS_ENDPOINT_TEMPLATE.format(task_id=task_id),
        headers=headers,
        timeout=60,
    )
    response.raise_for_status()
    return response.json()


def wait_until_finished(
    api_key: str,
    task_id: str,
    poll_interval: int,
    timeout_minutes: int,
    output_dir: Path,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_minutes * 60
    history = []

    while True:
        status_data = check_status(api_key, task_id)
        history.append(status_data)
        (output_dir / "status_history.json").write_text(
            json.dumps(history, indent=2),
            encoding="utf-8",
        )

        status = status_data.get("status")
        progress = status_data.get("progress")
        print(f"Status: {status} | Progress: {progress}", flush=True)

        if status == "FINISHED":
            results = status_data.get("results") or []
            if any(item.get("asset") for item in results if item.get("asset_type") == "3D_MODEL"):
                return status_data
            if time.monotonic() > deadline:
                raise TimeoutError(
                    f"Timed out after {timeout_minutes} minutes waiting for finished assets."
                )
            print(
                "Status is FINISHED, but the downloadable 3D_MODEL asset is not ready yet. "
                f"Checking again in {poll_interval}s...",
                flush=True,
            )
            time.sleep(poll_interval)
            continue
        if status in {"FAILED", "ERROR", "CANCELLED"}:
            raise RuntimeError(f"Generation failed: {status_data}")
        if status_data.get("failure_reason"):
            raise RuntimeError(f"Generation failed: {status_data}")
        if time.monotonic() > deadline:
            raise TimeoutError(f"Timed out after {timeout_minutes} minutes.")

        time.sleep(poll_interval)


def filename_from_url(url: str, fallback: str) -> str:
    name = Path(urlparse(url).path).name
    return name or fallback


def download_results(final_status: dict[str, Any], output_dir: Path) -> list[Path]:
    downloaded: list[Path] = []
    for index, item in enumerate(final_status.get("results", []), start=1):
        asset_url = item.get("asset")
        if not asset_url:
            continue
        file_name = filename_from_url(asset_url, f"result_{index}.glb")
        target_path = output_dir / file_name
        response = requests.get(asset_url, timeout=300)
        response.raise_for_status()
        target_path.write_bytes(response.content)
        downloaded.append(target_path)
    return downloaded


def write_manifest(
    output_dir: Path,
    input_dir: Path,
    ordered_images: list[tuple[str, Path]],
    unknown_images: list[Path],
    duplicates: dict[str, list[Path]],
    payload: dict[str, Any],
    submit_response: dict[str, Any] | None = None,
    final_status: dict[str, Any] | None = None,
    downloaded_files: list[Path] | None = None,
) -> None:
    manifest = {
        "input_dir": str(input_dir),
        "selected_images": [
            {"view_type": view_type, "path": str(path)}
            for view_type, path in ordered_images
        ],
        "unknown_images": [str(path) for path in unknown_images],
        "duplicate_images": {
            view_type: [str(path) for path in paths]
            for view_type, paths in duplicates.items()
        },
        "payload_summary": payload_summary(payload),
        "submit_response": submit_response,
        "final_status": final_status,
        "downloaded_files": [str(path) for path in downloaded_files or []],
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )


def print_selection(
    ordered_images: list[tuple[str, Path]],
    unknown_images: list[Path],
    duplicates: dict[str, list[Path]],
) -> None:
    print("Detected multi-view images:")
    for index, (view_type, path) in enumerate(ordered_images, start=1):
        print(f"  {index}. {view_type}: {path}")

    if unknown_images:
        print("Ignored files without a supported view_type in the name:")
        for path in unknown_images:
            print(f"  - {path}")

    if duplicates:
        print("Duplicate view_type files ignored after the first match:")
        for view_type, paths in duplicates.items():
            print(f"  - {view_type}: {', '.join(str(path) for path in paths[1:])}")


def main(default_model: str = "3.0") -> int:
    load_dotenv()
    args = parse_args(default_model=default_model)

    input_dir = args.input_dir.expanduser()
    if not input_dir.is_dir():
        print(f"Input folder not found: {input_dir}", file=sys.stderr)
        return 1

    ordered_images, unknown_images, duplicates = collect_images_by_view(input_dir, args.model)
    detected_views = {view_type for view_type, _ in ordered_images}
    if "front" not in detected_views:
        print("Missing required front view image.", file=sys.stderr)
        return 1
    if not ordered_images:
        print("No supported view-named images found.", file=sys.stderr)
        return 1

    output_root = args.output_root.expanduser()
    output_dir = build_output_dir_path(input_dir, output_root)
    payload = build_payload(args, ordered_images)

    print(f"Output folder: {output_dir}")
    print_selection(ordered_images, unknown_images, duplicates)
    print(f"Model: {args.model}")
    print(f"Enable PBR: {args.enable_pbr}")
    print(f"Estimated credits: {60 + 20 + (20 if args.enable_pbr else 0)}")

    if args.dry_run:
        print(json.dumps(payload_summary(payload), indent=2))
        print("Dry run only. No API request was sent.")
        return 0

    api_key = os.getenv("3DAISTUDIO_API_KEY")
    if not api_key:
        print("Missing 3DAISTUDIO_API_KEY in environment or .env.", file=sys.stderr)
        return 1

    output_dir.mkdir(parents=True, exist_ok=True)
    write_manifest(output_dir, input_dir, ordered_images, unknown_images, duplicates, payload)
    print(f"Manifest: {output_dir / 'manifest.json'}", flush=True)

    try:
        submit_response = submit_generation_with_log(api_key, payload, output_dir)
        (output_dir / "submit_response.json").write_text(
            json.dumps(submit_response, indent=2),
            encoding="utf-8",
        )
        task_id = submit_response.get("task_id")
        if not task_id:
            raise RuntimeError(f"Missing task_id in submit response: {submit_response}")

        print(f"Task ID: {task_id}", flush=True)
        final_status = wait_until_finished(
            api_key=api_key,
            task_id=task_id,
            poll_interval=args.poll_interval,
            timeout_minutes=args.timeout_minutes,
            output_dir=output_dir,
        )
        (output_dir / "final_status.json").write_text(
            json.dumps(final_status, indent=2),
            encoding="utf-8",
        )
        downloaded_files = download_results(final_status, output_dir)
        write_manifest(
            output_dir=output_dir,
            input_dir=input_dir,
            ordered_images=ordered_images,
            unknown_images=unknown_images,
            duplicates=duplicates,
            payload=payload,
            submit_response=submit_response,
            final_status=final_status,
            downloaded_files=downloaded_files,
        )
    except Exception as exc:
        print(f"3D AI Studio processing failed: {exc}", file=sys.stderr)
        print(f"Manifest: {output_dir / 'manifest.json'}", file=sys.stderr)
        attempts_path = output_dir / "submit_attempts.json"
        if attempts_path.exists():
            print(f"Submit attempts log: {attempts_path}", file=sys.stderr)
        return 1

    glb_files = [path for path in downloaded_files if path.suffix.lower() == ".glb"]
    if glb_files:
        print("GLB files:")
        for path in glb_files:
            print(f"  {path}")
        return 0

    print("No .glb file was downloaded.", file=sys.stderr)
    print(f"Downloaded files: {', '.join(str(path) for path in downloaded_files)}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
