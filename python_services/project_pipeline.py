#!/usr/bin/env python3
"""End-to-end photo editing and 3D model generation pipeline."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, TextIO

from dotenv import load_dotenv
from openai import OpenAI


SERVICE_DIR = Path(__file__).resolve().parent
APP_DIR = SERVICE_DIR.parent
load_dotenv(APP_DIR / ".env", override=True)
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from edit_house_image import DEFAULT_PROMPT, build_prompt, process_image
from bulk_edit_house_images import COST_PER_IMAGE_USD, is_image_file
import hyper3d_image_to_3d as hyper3d
from tencent_hunyuan_3d import (
    VIEW_TYPES_BY_MODEL,
    build_payload,
    collect_images_by_view,
    detect_view_type,
    download_results,
    payload_summary,
    submit_generation_with_log,
    upload_order_for_model,
    wait_until_finished,
    write_manifest,
)


def resolve_projects_root() -> Path:
    raw_path = os.getenv("PROJECTS_PATH", "projects").strip().strip('"').strip("'")
    if not raw_path:
        raw_path = "projects"

    projects_path = Path(raw_path).expanduser()
    if projects_path.is_absolute():
        return projects_path
    return (APP_DIR / projects_path).resolve()


PROJECTS_ROOT = resolve_projects_root()
DEFAULT_PROJECT = PROJECTS_ROOT / "project_1"
DEFAULT_IMAGE_MODEL = "gpt-image-2"
DEFAULT_IMAGE_SIZE = "1536x1024"
DEFAULT_IMAGE_QUALITY = "high"
DEFAULT_IMAGE_FORMAT = "png"
DEFAULT_HUNYUAN_MODEL = "3.1"
DEFAULT_MAX_IMAGE_SIDE = 1024
DEFAULT_JPEG_QUALITY = 85
DEFAULT_MODEL_PROVIDER = "tencent"
DEFAULT_HYPER3D_PROMPT = (
    "Create a coherent 3D model of one residential house or small building from the uploaded "
    "labeled views. Align facades, corners, walls, windows, doors, porch, garage volumes, chimneys, "
    "roof planes, and proportions into one consistent structure. Preserve the real geometry shown "
    "in the photos. The entire top of the building must be covered by roof geometry: do not leave "
    "holes, open voids, transparent gaps, or missing roof surfaces, even for flat or low-slope roofs. "
    "Infer continuous roof planes where views are incomplete. Avoid duplicate walls, extra buildings, "
    "distorted roofs, or mismatched openings."
)
HYPER3D_WEBAPP_UPLOAD_ORDER = [
    "front",
    "up",
    "front-left",
    "left",
    "back-left",
    "back",
    "back-right",
    "right",
    "front-right",
]
HUNYUAN_TO_HYPER3D_ANGLE = {
    "front": "front",
    "top": "up",
    "left_front": "front-left",
    "left": "left",
    "back_left": "back-left",
    "back": "back",
    "back_right": "back-right",
    "right": "right",
    "right_front": "front-right",
}


class TeeStream:
    def __init__(self, *streams: TextIO) -> None:
        self.streams = streams

    def write(self, value: str) -> int:
        for stream in self.streams:
            stream.write(value)
            stream.flush()
        return len(value)

    def flush(self) -> None:
        for stream in self.streams:
            stream.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Edit project photos and generate a GLB with Tencent Hunyuan 3.1."
    )
    parser.add_argument(
        "--project",
        type=Path,
        default=DEFAULT_PROJECT,
        help="Project folder containing input_photos, output_photos, and output_glb.",
    )
    parser.add_argument(
        "--prompt",
        default=DEFAULT_PROMPT,
        help="OpenAI image editing prompt.",
    )
    parser.add_argument(
        "--prompt-file",
        type=Path,
        help="Optional text file with the OpenAI image editing prompt.",
    )
    parser.add_argument("--image-model", default=DEFAULT_IMAGE_MODEL)
    parser.add_argument("--image-size", default=DEFAULT_IMAGE_SIZE)
    parser.add_argument(
        "--image-quality",
        default=DEFAULT_IMAGE_QUALITY,
        choices=["low", "medium", "high", "auto"],
    )
    parser.add_argument(
        "--image-output-format",
        default=DEFAULT_IMAGE_FORMAT,
        choices=["png", "jpeg", "webp"],
    )
    parser.add_argument(
        "--model-provider",
        default=DEFAULT_MODEL_PROVIDER,
        choices=["tencent", "hyper3d"],
        help="3D generation provider used after image editing.",
    )
    parser.add_argument("--hunyuan-model", default=DEFAULT_HUNYUAN_MODEL, choices=["3.0", "3.1"])
    parser.add_argument("--enable-pbr", action="store_true", help="Enable PBR textures in the GLB request.")
    parser.add_argument("--face-count", type=int, default=None)
    parser.add_argument("--generate-type", default=None)
    parser.set_defaults(hunyuan_prompt=None)
    parser.add_argument("--max-image-side", type=int, default=DEFAULT_MAX_IMAGE_SIDE)
    parser.add_argument("--jpeg-quality", type=int, default=DEFAULT_JPEG_QUALITY)
    parser.add_argument("--poll-interval", type=int, default=20)
    parser.add_argument("--timeout-minutes", type=int, default=30)
    parser.add_argument(
        "--include-primary-image",
        action="store_true",
        help="Also send the front image in the top-level image field.",
    )
    parser.add_argument("--hyper3d-max-images", type=int, default=5)
    parser.add_argument("--hyper3d-tier", default="Gen-2.5-High")
    parser.add_argument("--hyper3d-mesh-mode", default="Raw", choices=["Raw", "Quad"])
    parser.add_argument("--hyper3d-geometry-file-format", default="glb")
    parser.add_argument("--hyper3d-material", default="PBR")
    parser.add_argument("--hyper3d-quality", default=None)
    parser.add_argument("--hyper3d-quality-override", default="500000")
    parser.add_argument("--hyper3d-texture-mode", default="high")
    parser.add_argument(
        "--hyper3d-geometry-instruct-mode",
        default="creative",
        choices=["faithful", "creative"],
    )
    parser.add_argument("--hyper3d-prompt", default=DEFAULT_HYPER3D_PROMPT)
    parser.add_argument(
        "--hyper3d-bang",
        action="store_true",
        help="Run Hyper3D Bang against the generated Rodin asset and download exploded outputs.",
    )
    parser.add_argument("--hyper3d-preview-render", action="store_true", default=True)
    parser.add_argument("--no-hyper3d-preview-render", dest="hyper3d_preview_render", action="store_false")
    parser.add_argument("--hyper3d-hd-texture", action="store_true")
    parser.add_argument("--hyper3d-texture-delight", action="store_true")
    parser.add_argument(
        "--skip-photo-edit",
        action="store_true",
        help="Skip OpenAI photo editing and use existing files in output_photos/edited.",
    )
    parser.add_argument(
        "--skip-3d",
        action="store_true",
        help="Only edit photos; do not call 3D AI Studio.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print planned work without calling OpenAI or 3D AI Studio.",
    )
    parser.add_argument(
        "--stop-on-edit-error",
        action="store_true",
        help="Stop immediately if one photo edit fails.",
    )
    return parser.parse_args()


def resolve_project(project: Path) -> Path:
    if project.is_absolute():
        return project

    project_text = str(project).replace("\\", "/")
    if project_text.startswith("project_") and "/" not in project_text:
        return (PROJECTS_ROOT / project).resolve()

    app_relative = APP_DIR / project
    if app_relative.exists() or project_text.startswith("projects/"):
        return app_relative.resolve()

    return (Path.cwd() / project).resolve()


def run_id() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def format_duration(seconds: float) -> str:
    seconds_int = int(seconds)
    hours, remainder = divmod(seconds_int, 3600)
    minutes, seconds_part = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes}m {seconds_part}s"
    if minutes:
        return f"{minutes}m {seconds_part}s"
    return f"{seconds_part}s"


def image_files(folder: Path) -> list[Path]:
    return sorted(path for path in folder.iterdir() if is_image_file(path))


def collect_images_by_view_from_paths(
    paths: list[Path],
    model: str,
) -> tuple[list[tuple[str, Path]], list[Path], dict[str, list[Path]]]:
    allowed_views = VIEW_TYPES_BY_MODEL[model]
    images_by_view: dict[str, Path] = {}
    duplicates: dict[str, list[Path]] = {}
    unknown: list[Path] = []

    for image_path in sorted(paths):
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


def ensure_project_folders(project_dir: Path) -> dict[str, Path]:
    folders = {
        "project": project_dir,
        "input": project_dir / "input_photos",
        "output_photos": project_dir / "output_photos",
        "edited": project_dir / "output_photos" / "edited",
        "comparison": project_dir / "output_photos" / "comparison",
        "output_glb": project_dir / "output_glb",
        "logs": project_dir / "logs",
    }
    for folder in folders.values():
        folder.mkdir(parents=True, exist_ok=True)
    return folders


def estimated_edit_cost(image_count: int) -> str:
    return f"${image_count * COST_PER_IMAGE_USD:.3f}"


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def read_project_manifest(project_dir: Path) -> dict[str, Any]:
    manifest_path = project_dir / "project_manifest.json"
    try:
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def update_project_manifest(project_dir: Path, patch: dict[str, Any]) -> None:
    manifest_path = project_dir / "project_manifest.json"
    manifest = read_project_manifest(project_dir)
    manifest.update(patch)
    write_json(manifest_path, manifest)


def manifest_requests_photo_edit_skip(manifest: dict[str, Any]) -> bool:
    return bool(
        manifest.get("skipPhotoEdit")
        or manifest.get("rawHyper3dImagesOnly")
        or manifest.get("batchMode") == "hyper3d_raw"
        or manifest.get("source") == "batch_hyper3d_raw"
        or (
            manifest.get("batchMode") == "by_model"
            and manifest.get("imageSource") == "original"
        )
        or (
            manifest.get("source") == "batch_by_model"
            and manifest.get("imageSource") == "original"
        )
    )


def seed_raw_images_as_edited(input_images: list[Path], folders: dict[str, Path]) -> list[Path]:
    folders["edited"].mkdir(parents=True, exist_ok=True)
    seeded_paths = []
    for input_path in input_images:
        target_path = folders["edited"] / f"{input_path.stem}_edited{input_path.suffix.lower()}"
        if not target_path.is_file():
            shutil.copy2(input_path, target_path)
        seeded_paths.append(target_path)
    return seeded_paths


def expected_photo_outputs(
    input_images: list[Path],
    folders: dict[str, Path],
    output_format: str,
) -> list[tuple[Path, Path, Path]]:
    return [
        (
            input_path,
            folders["edited"] / f"{input_path.stem}_edited.{output_format}",
            folders["comparison"] / f"{input_path.stem}_comparison.png",
        )
        for input_path in input_images
    ]


def completed_photo_outputs(
    input_images: list[Path],
    folders: dict[str, Path],
    output_format: str,
) -> tuple[bool, list[Path], list[Path]]:
    expected_outputs = expected_photo_outputs(input_images, folders, output_format)
    edited_paths = [edited_path for _, edited_path, _ in expected_outputs]
    missing = [
        output_path
        for _, edited_path, comparison_path in expected_outputs
        for output_path in (edited_path, comparison_path)
        if not output_path.is_file()
    ]
    return not missing, edited_paths, missing


def edit_project_photos(
    args: argparse.Namespace,
    folders: dict[str, Path],
    prompt: str,
) -> list[Path]:
    input_images = image_files(folders["input"])
    edited_paths: list[Path] = []
    skip_photo_edit = bool(args.skip_photo_edit)

    print(
        "\n=== Step 1/2: Raw Image Preparation ===" if skip_photo_edit else "\n=== Step 1/2: Photo Editing ===",
        flush=True,
    )
    print(f"Input folder: {folders['input']}", flush=True)
    print(f"Edited output folder: {folders['edited']}", flush=True)
    print(f"Comparison output folder: {folders['comparison']}", flush=True)

    if not input_images:
        raise RuntimeError(f"No input images found in {folders['input']}")

    if skip_photo_edit:
        existing = image_files(folders["edited"])
        print("OpenAI photo editing is disabled for this project.", flush=True)
        print(f"Images found: {len(input_images)}", flush=True)
        print(f"Existing raw/edited images found: {len(existing)}", flush=True)
        print("Images requiring OpenAI edit: 0", flush=True)
        print("Estimated OpenAI edit cost: $0.000", flush=True)
        if existing:
            print("Using existing raw images from output_photos/edited.", flush=True)
            return existing
        seeded = seed_raw_images_as_edited(input_images, folders)
        print(f"Seeded raw images into output_photos/edited: {len(seeded)}", flush=True)
        for path in seeded:
            print(f"Raw image ready: {path}", flush=True)
        return seeded

    existing_output_pairs = [
        (input_path, edited_path, comparison_path)
        for input_path, edited_path, comparison_path in expected_photo_outputs(
            input_images,
            folders,
            args.image_output_format,
        )
        if edited_path.is_file() and comparison_path.is_file()
    ]
    pending_output_pairs = [
        (input_path, edited_path, comparison_path)
        for input_path, edited_path, comparison_path in expected_photo_outputs(
            input_images,
            folders,
            args.image_output_format,
        )
        if not (edited_path.is_file() and comparison_path.is_file())
    ]

    print(f"Images found: {len(input_images)}", flush=True)
    print(f"Existing edited image pairs: {len(existing_output_pairs)}", flush=True)
    print(f"Images requiring OpenAI edit: {len(pending_output_pairs)}", flush=True)
    print(f"Estimated OpenAI edit cost: {estimated_edit_cost(len(pending_output_pairs))}", flush=True)

    outputs_complete, existing_edited_paths, missing_outputs = completed_photo_outputs(
        input_images,
        folders,
        args.image_output_format,
    )
    if outputs_complete:
        print(
            "Photo outputs already complete. Skipping OpenAI photo editing and using existing edited images.",
            flush=True,
        )
        print(f"Existing edited images: {len(existing_edited_paths)}", flush=True)
        print(f"Existing comparisons: {len(input_images)}", flush=True)
        return existing_edited_paths

    if args.dry_run:
        if missing_outputs:
            print("Photo outputs are incomplete. Missing files:", flush=True)
            for output_path in missing_outputs:
                print(f"  - {output_path}", flush=True)
        for image_path, edited_path, comparison_path in expected_photo_outputs(
            input_images,
            folders,
            args.image_output_format,
        ):
            print(f"[DRY RUN] {image_path.name} -> {edited_path.name} | {comparison_path.name}", flush=True)
            edited_paths.append(edited_path)
        return edited_paths

    client = OpenAI()
    step_started = time.monotonic()
    failed: list[tuple[Path, str]] = []

    for _input_path, edited_path, _comparison_path in existing_output_pairs:
        edited_paths.append(edited_path)
        print(f"Reusing existing edited output: {edited_path.name}", flush=True)

    for index, (image_path, edited_path, comparison_path) in enumerate(pending_output_pairs, start=1):
        item_started = time.monotonic()
        print(f"[{index}/{len(pending_output_pairs)}] Editing: {image_path.name}", flush=True)

        try:
            process_image(
                client=client,
                input_path=image_path,
                edited_path=edited_path,
                comparison_path=comparison_path,
                prompt=prompt,
                model=args.image_model,
                size=args.image_size,
                quality=args.image_quality,
                output_format=args.image_output_format,
            )
        except Exception as exc:
            failed.append((image_path, str(exc)))
            print(f"FAILED: {image_path.name}: {exc}", file=sys.stderr, flush=True)
            if args.stop_on_edit_error:
                raise
            continue

        edited_paths.append(edited_path)
        elapsed = format_duration(time.monotonic() - item_started)
        print(f"Edited: {edited_path}", flush=True)
        print(f"Comparison: {comparison_path}", flush=True)
        print(f"Photo elapsed: {elapsed}", flush=True)

    print(
        f"Photo editing done. Completed: {len(edited_paths)}. "
        f"Failed: {len(failed)}. Elapsed: {format_duration(time.monotonic() - step_started)}",
        flush=True,
    )

    if failed:
        write_json(
            folders["output_photos"] / "photo_edit_failures.json",
            {"failures": [{"path": str(path), "error": error} for path, error in failed]},
        )
        raise RuntimeError(f"Photo editing finished with {len(failed)} failed image(s).")

    return edited_paths


def build_hunyuan_args(args: argparse.Namespace) -> SimpleNamespace:
    return SimpleNamespace(
        model=args.hunyuan_model,
        enable_pbr=args.enable_pbr,
        face_count=args.face_count,
        generate_type=args.generate_type,
        prompt=args.hunyuan_prompt,
        max_image_side=args.max_image_side,
        jpeg_quality=args.jpeg_quality,
        include_primary_image=args.include_primary_image,
    )


def generate_tencent_3d_model(
    args: argparse.Namespace,
    folders: dict[str, Path],
    edited_paths: list[Path] | None = None,
) -> list[Path]:
    print("\n=== Step 2/2: 3D Model Generation ===", flush=True)
    edited_dir = folders["edited"]
    glb_output_dir = folders["output_glb"]
    glb_output_dir.mkdir(parents=True, exist_ok=True)

    if args.dry_run and edited_paths:
        ordered_images, unknown_images, duplicates = collect_images_by_view_from_paths(
            edited_paths,
            args.hunyuan_model,
        )
    else:
        ordered_images, unknown_images, duplicates = collect_images_by_view(edited_dir, args.hunyuan_model)
    detected_views = [view_type for view_type, _ in ordered_images]

    print(f"Edited input folder: {edited_dir}", flush=True)
    print(f"GLB output folder: {glb_output_dir}", flush=True)
    print(f"Hunyuan model: {args.hunyuan_model}", flush=True)
    print(f"Enable PBR: {args.enable_pbr}", flush=True)
    print(f"Detected views: {', '.join(detected_views) if detected_views else '(none)'}", flush=True)
    print("Hunyuan prompt: disabled for multi-view image payloads", flush=True)
    print(f"Estimated 3D AI Studio credits: {60 + 20 + (20 if args.enable_pbr else 0)}", flush=True)

    if "front" not in set(detected_views):
        raise RuntimeError("Missing required front view in output_photos/edited.")
    if not ordered_images:
        raise RuntimeError("No supported view-named edited images found.")

    for index, (view_type, path) in enumerate(ordered_images, start=1):
        print(f"  {index}. {view_type}: {path.name}", flush=True)
    if unknown_images:
        print("Ignored edited images without supported view names:", flush=True)
        for path in unknown_images:
            print(f"  - {path.name}", flush=True)
    if duplicates:
        print("Duplicate view names ignored after first match:", flush=True)
        for view_type, paths in duplicates.items():
            print(f"  - {view_type}: {', '.join(path.name for path in paths[1:])}", flush=True)

    hunyuan_args = build_hunyuan_args(args)
    if args.dry_run:
        print("Payload summary will be generated after the edited files exist.", flush=True)
        print("Dry-run view payload preview:", flush=True)
        print(
            json.dumps(
                {
                    "model": args.hunyuan_model,
                    "enable_pbr": args.enable_pbr,
                    "multi_view_images": [
                        {"view_type": view_type, "view_image": f"{path.name} -> data:image/jpeg;base64,<base64 omitted>"}
                        for view_type, path in ordered_images
                    ],
                },
                indent=2,
            ),
            flush=True,
        )
        print("Dry run only. No 3D AI Studio request was sent.", flush=True)
        return []

    payload = build_payload(hunyuan_args, ordered_images)
    write_manifest(glb_output_dir, edited_dir, ordered_images, unknown_images, duplicates, payload)

    api_key = os.getenv("API_KEY_3DAISTUDIO")
    if not api_key:
        raise RuntimeError(f"Missing API_KEY_3DAISTUDIO in {APP_DIR / '.env'}.")

    step_started = time.monotonic()
    submit_response = submit_generation_with_log(api_key, payload, glb_output_dir)
    write_json(glb_output_dir / "submit_response.json", submit_response)

    task_id = submit_response.get("task_id")
    if not task_id:
        raise RuntimeError(f"Missing task_id in submit response: {submit_response}")

    print(f"Task ID: {task_id}", flush=True)
    final_status = wait_until_finished(
        api_key=api_key,
        task_id=task_id,
        poll_interval=args.poll_interval,
        timeout_minutes=args.timeout_minutes,
        output_dir=glb_output_dir,
    )
    write_json(glb_output_dir / "final_status.json", final_status)

    downloaded_files = download_results(final_status, glb_output_dir)
    write_manifest(
        output_dir=glb_output_dir,
        input_dir=edited_dir,
        ordered_images=ordered_images,
        unknown_images=unknown_images,
        duplicates=duplicates,
        payload=payload,
        submit_response=submit_response,
        final_status=final_status,
        downloaded_files=downloaded_files,
    )

    glb_files = [path for path in downloaded_files if path.suffix.lower() == ".glb"]
    print(f"3D generation elapsed: {format_duration(time.monotonic() - step_started)}", flush=True)
    if glb_files:
        print("GLB files:", flush=True)
        for path in glb_files:
            print(f"  {path}", flush=True)
    else:
        print(f"Downloaded files: {', '.join(str(path) for path in downloaded_files)}", flush=True)
        raise RuntimeError("No .glb file was downloaded.")

    return glb_files


def build_hyper3d_args(args: argparse.Namespace) -> SimpleNamespace:
    return SimpleNamespace(
        max_images=args.hyper3d_max_images,
        tier=args.hyper3d_tier,
        mesh_mode=args.hyper3d_mesh_mode,
        geometry_file_format=args.hyper3d_geometry_file_format,
        material=args.hyper3d_material,
        quality=args.hyper3d_quality,
        quality_override=args.hyper3d_quality_override,
        texture_mode=args.hyper3d_texture_mode,
        geometry_instruct_mode=args.hyper3d_geometry_instruct_mode,
        prompt=args.hyper3d_prompt,
        preview_render=args.hyper3d_preview_render,
        hd_texture=args.hyper3d_hd_texture,
        texture_delight=args.hyper3d_texture_delight,
        poll_interval=args.poll_interval,
        timeout_minutes=args.timeout_minutes,
        dry_run=args.dry_run,
    )


def run_hyper3d_bang(
    args: argparse.Namespace,
    folders: dict[str, Path],
    api_key: str,
    generation_response: dict[str, Any],
) -> list[Path]:
    source_task_uuid = generation_response.get("uuid")
    if not source_task_uuid:
        raise RuntimeError(f"Hyper3D Bang requires the Rodin generation uuid: {generation_response}")

    bang_output_dir = folders["output_glb"] / "bang"
    bang_output_dir.mkdir(parents=True, exist_ok=True)

    print("", flush=True)
    print("=== Hyper3D Bang ===", flush=True)
    print(f"Source asset_id: {source_task_uuid}", flush=True)
    print("Strength: 5", flush=True)
    print("Material: PBR", flush=True)
    print("Resolution: Basic", flush=True)

    bang_response = hyper3d.submit_bang(
        api_key=api_key,
        asset_id=str(source_task_uuid),
        strength=5,
        geometry_file_format="glb",
        material="PBR",
        resolution="Basic",
    )
    write_json(bang_output_dir / "hyper3d_bang_response.json", bang_response)

    bang_task_uuid = bang_response.get("uuid") or bang_response.get("task_uuid")
    if not bang_task_uuid:
        raise RuntimeError(f"Missing Hyper3D Bang uuid in response: {bang_response}")

    print(f"Bang task UUID: {bang_task_uuid}", flush=True)
    try:
        bang_status = hyper3d.wait_until_done_by_task_uuid(
            api_key=api_key,
            task_uuid=str(bang_task_uuid),
            poll_interval=args.poll_interval,
            timeout_minutes=args.timeout_minutes,
            output_dir=bang_output_dir,
            history_file_name="hyper3d_bang_status_history.json",
        )
    except Exception as exc:
        subscription_key = bang_response.get("jobs", {}).get("subscription_key")
        if not subscription_key:
            raise
        print(f"Bang task_uuid status failed; retrying with subscription_key. Reason: {exc}", flush=True)
        bang_status = hyper3d.wait_until_done(
            api_key=api_key,
            subscription_key=subscription_key,
            poll_interval=args.poll_interval,
            timeout_minutes=args.timeout_minutes,
            output_dir=bang_output_dir,
        )
    write_json(bang_output_dir / "hyper3d_bang_final_status.json", bang_status)

    bang_download_response = hyper3d.download_result_list(api_key, str(bang_task_uuid))
    write_json(bang_output_dir / "hyper3d_bang_download_response.json", bang_download_response)
    bang_files = hyper3d.download_files(bang_download_response, bang_output_dir)

    metadata = {
        "enabled": True,
        "source_task_uuid": str(source_task_uuid),
        "bang_task_uuid": str(bang_task_uuid),
        "request": {
            "strength": 5,
            "geometry_file_format": "glb",
            "material": "PBR",
            "resolution": "Basic",
        },
        "response": bang_response,
        "final_status": bang_status,
        "download_response": bang_download_response,
        "downloaded_files": [str(path) for path in bang_files],
    }
    write_json(bang_output_dir / "hyper3d_bang_manifest.json", metadata)
    update_project_manifest(folders["project"], {"hyper3dBang": metadata})

    if bang_files:
        print("Bang files:", flush=True)
        for path in bang_files:
            print(f"  {path}", flush=True)
    else:
        raise RuntimeError("Hyper3D Bang finished but no files were downloaded.")

    return bang_files


def collect_hyper3d_images_from_paths(
    paths: list[Path],
    max_images: int,
) -> tuple[list[tuple[str, Path]], list[tuple[str, Path]], list[Path], dict[str, list[Path]]]:
    allowed_webapp_views = list(HUNYUAN_TO_HYPER3D_ANGLE)
    images_by_angle: dict[str, Path] = {}
    duplicates: dict[str, list[Path]] = {}
    unknown: list[Path] = []

    for image_path in sorted(paths):
        view_type = detect_view_type(image_path, allowed_webapp_views)
        angle = HUNYUAN_TO_HYPER3D_ANGLE.get(view_type or "")
        if not angle:
            unknown.append(image_path)
            continue
        if angle in images_by_angle:
            duplicates.setdefault(angle, [images_by_angle[angle]]).append(image_path)
            continue
        images_by_angle[angle] = image_path

    ordered = [
        (angle, images_by_angle[angle])
        for angle in HYPER3D_WEBAPP_UPLOAD_ORDER
        if angle in images_by_angle
    ]
    return ordered[:max_images], ordered[max_images:], unknown, duplicates


def generate_hyper3d_model(
    args: argparse.Namespace,
    folders: dict[str, Path],
    edited_paths: list[Path] | None = None,
) -> list[Path]:
    print("\n=== Step 2/2: 3D Model Generation ===", flush=True)
    edited_dir = folders["edited"]
    glb_output_dir = folders["output_glb"]
    glb_output_dir.mkdir(parents=True, exist_ok=True)

    source_paths = edited_paths if args.dry_run and edited_paths else image_files(edited_dir)
    hyper3d_args = build_hyper3d_args(args)
    ordered_images, skipped_images, unknown_images, duplicates = collect_hyper3d_images_from_paths(
        source_paths,
        hyper3d_args.max_images,
    )
    detected_angles = [angle for angle, _ in ordered_images]

    print(f"Edited input folder: {edited_dir}", flush=True)
    print(f"GLB output folder: {glb_output_dir}", flush=True)
    print("3D provider: Hyper3D Rodin Gen-2.5", flush=True)
    print(f"Detected Hyper3D angles: {', '.join(detected_angles) if detected_angles else '(none)'}", flush=True)
    print(f"Max images sent to Hyper3D: {hyper3d_args.max_images}", flush=True)
    print(f"Tier: {hyper3d_args.tier}", flush=True)
    print(f"Mesh mode: {hyper3d_args.mesh_mode}", flush=True)

    if not ordered_images:
        raise RuntimeError("No supported view-named edited images found for Hyper3D.")
    if "front" not in set(detected_angles):
        print("Hyper3D front view not provided; continuing with available image labels.", flush=True)

    hyper3d.print_selection(
        "hyper3d webapp counter-clockwise",
        ordered_images,
        skipped_images,
        unknown_images,
        duplicates,
    )

    prompt = hyper3d_args.prompt
    fields = hyper3d.request_fields(hyper3d_args, prompt, ordered_images)
    print(f"Image labels: {hyper3d.format_image_label_field(hyper3d.image_labels_for(ordered_images))}", flush=True)
    print(f"Hyper3D prompt ({len(prompt)} chars):", flush=True)
    print(prompt, flush=True)

    if args.dry_run:
        print("Dry-run Hyper3D payload preview:", flush=True)
        print(
            json.dumps(
                {
                    "provider": "hyper3d",
                    "fields": dict(fields),
                    "images": [
                        {"angle": angle, "file": path.name}
                        for angle, path in ordered_images
                    ],
                    "skipped_images": [
                        {"angle": angle, "file": path.name}
                        for angle, path in skipped_images
                    ],
                },
                indent=2,
            ),
            flush=True,
        )
        print("Dry run only. No Hyper3D request was sent.", flush=True)
        return []

    api_key = os.getenv("HYPER3D_API_KEY")
    if not api_key:
        raise RuntimeError(f"Missing HYPER3D_API_KEY in {APP_DIR / '.env'}.")

    step_started = time.monotonic()
    hyper3d.write_manifest(
        output_dir=glb_output_dir,
        input_dir=edited_dir,
        direction="webapp_counter_clockwise",
        angle_order=HYPER3D_WEBAPP_UPLOAD_ORDER,
        ordered_images=ordered_images,
        skipped_images=skipped_images,
        unknown_images=unknown_images,
        duplicate_images=duplicates,
        fields=fields,
        prompt=prompt,
    )

    generation_response = hyper3d.submit_generation(api_key, ordered_images, fields)
    write_json(glb_output_dir / "hyper3d_generation_response.json", generation_response)

    task_uuid = generation_response.get("uuid")
    subscription_key = generation_response.get("jobs", {}).get("subscription_key")
    if not task_uuid or not subscription_key:
        raise RuntimeError(f"Missing uuid or subscription_key: {generation_response}")

    print(f"Task UUID: {task_uuid}", flush=True)
    print(f"Subscription key: {subscription_key}", flush=True)
    hyper3d.wait_until_done(
        api_key=api_key,
        subscription_key=subscription_key,
        poll_interval=args.poll_interval,
        timeout_minutes=args.timeout_minutes,
        output_dir=glb_output_dir,
    )

    download_response = hyper3d.download_result_list(api_key, task_uuid)
    write_json(glb_output_dir / "hyper3d_download_response.json", download_response)
    downloaded_files = hyper3d.download_files(download_response, glb_output_dir)
    hyper3d.write_manifest(
        output_dir=glb_output_dir,
        input_dir=edited_dir,
        direction="webapp_counter_clockwise",
        angle_order=HYPER3D_WEBAPP_UPLOAD_ORDER,
        ordered_images=ordered_images,
        skipped_images=skipped_images,
        unknown_images=unknown_images,
        duplicate_images=duplicates,
        fields=fields,
        prompt=prompt,
        generation_response=generation_response,
        download_response=download_response,
        downloaded_files=downloaded_files,
    )

    glb_files = [path for path in downloaded_files if path.suffix.lower() == ".glb"]
    print(f"3D generation elapsed: {format_duration(time.monotonic() - step_started)}", flush=True)
    if glb_files:
        print("GLB files:", flush=True)
        for path in glb_files:
            print(f"  {path}", flush=True)
    else:
        print(f"Downloaded files: {', '.join(str(path) for path in downloaded_files)}", flush=True)
        raise RuntimeError("No .glb file was downloaded.")

    if args.hyper3d_bang:
        run_hyper3d_bang(args, folders, api_key, generation_response)
    else:
        print("Hyper3D Bang: disabled", flush=True)

    return glb_files


def generate_3d_model(
    args: argparse.Namespace,
    folders: dict[str, Path],
    edited_paths: list[Path] | None = None,
) -> list[Path]:
    if args.model_provider == "hyper3d":
        return generate_hyper3d_model(args, folders, edited_paths)
    return generate_tencent_3d_model(args, folders, edited_paths)


def run_pipeline(args: argparse.Namespace) -> int:
    load_dotenv(APP_DIR / ".env")
    project_dir = resolve_project(args.project)
    folders = ensure_project_folders(project_dir)
    manifest = read_project_manifest(project_dir)
    if manifest_requests_photo_edit_skip(manifest):
        args.skip_photo_edit = True
    current_run = args.run_id
    pipeline_started = time.monotonic()

    try:
        prompt = build_prompt(args.prompt, args.prompt_file)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print("Phone Mapping V1 Pipeline", flush=True)
    print(f"Run ID: {current_run}", flush=True)
    print(f"Project folder: {project_dir}", flush=True)
    print(f"Environment file: {APP_DIR / '.env'}", flush=True)
    print(f"3D model provider: {args.model_provider}", flush=True)
    print(f"Dry run: {args.dry_run}", flush=True)
    print(f"Skip OpenAI photo editing: {args.skip_photo_edit}", flush=True)

    summary: dict[str, Any] = {
        "run_id": current_run,
        "project_dir": str(project_dir),
        "model_provider": args.model_provider,
        "dry_run": args.dry_run,
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "status": "running",
    }

    try:
        edited_paths = edit_project_photos(args, folders, prompt)
        summary["edited_images"] = [str(path) for path in edited_paths]

        glb_files: list[Path] = []
        if args.skip_3d:
            print("\nSkipping 3D generation because --skip-3d was provided.", flush=True)
        else:
            glb_files = generate_3d_model(args, folders, edited_paths)
        summary["glb_files"] = [str(path) for path in glb_files]
        summary["status"] = "completed"
        return_code = 0
    except Exception as exc:
        summary["status"] = "failed"
        summary["error"] = str(exc)
        print(f"\nPIPELINE FAILED: {exc}", file=sys.stderr, flush=True)
        return_code = 1
    finally:
        elapsed = time.monotonic() - pipeline_started
        summary["finished_at"] = datetime.now().isoformat(timespec="seconds")
        summary["elapsed_seconds"] = round(elapsed, 2)
        summary["elapsed"] = format_duration(elapsed)
        write_json(folders["logs"] / f"pipeline_{current_run}.json", summary)
        print(f"\nTotal pipeline elapsed: {format_duration(elapsed)}", flush=True)
        print(f"Summary JSON: {folders['logs'] / f'pipeline_{current_run}.json'}", flush=True)

    return return_code


def main() -> int:
    args = parse_args()
    project_dir = resolve_project(args.project)
    log_dir = project_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    current_run = run_id()
    args.run_id = current_run
    log_path = log_dir / f"pipeline_{current_run}.log"

    with log_path.open("a", encoding="utf-8") as log_file:
        original_stdout = sys.stdout
        original_stderr = sys.stderr
        sys.stdout = TeeStream(original_stdout, log_file)  # type: ignore[assignment]
        sys.stderr = TeeStream(original_stderr, log_file)  # type: ignore[assignment]
        try:
            print(f"Log file: {log_path}", flush=True)
            return run_pipeline(args)
        finally:
            sys.stdout = original_stdout
            sys.stderr = original_stderr


if __name__ == "__main__":
    raise SystemExit(main())
