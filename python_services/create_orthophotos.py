#!/usr/bin/env python3
"""Create orthographic GLB face renders for one Phone Mapping project."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import trimesh
from PIL import Image, ImageChops


APP_ROOT = Path(__file__).resolve().parents[1]
RENDERER_PATH = APP_ROOT / "python_services" / "orthophotos" / "render_glb_faces.py"
FACES = ["front", "back", "right", "left", "top"]
MODEL_DIMENSIONS_NAME = "glb_model_dimensions.json"


def load_renderer():
    spec = importlib.util.spec_from_file_location("render_glb_faces", RENDERER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load renderer script: {RENDERER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create orthophotos for a project GLB.")
    parser.add_argument("--model", required=True, help="Path to the GLB file.")
    parser.add_argument("--output-dir", required=True, help="Exact output folder for PNG files.")
    parser.add_argument("--width", type=int, default=1600)
    parser.add_argument("--height", type=int, default=1000)
    parser.add_argument("--padding", type=float, default=1.08)
    parser.add_argument("--target-width", type=float, default=10.0)
    parser.add_argument("--wait-ms", type=int, default=30000)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--retry-wait-step-ms", type=int, default=20000)
    parser.add_argument("--min-file-size", type=int, default=10000)
    parser.add_argument("--browser")
    parser.add_argument("--show-box", action="store_true")
    parser.add_argument("--no-dimensions", action="store_false", dest="dimensions")
    parser.set_defaults(dimensions=False)
    return parser


def visible_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")

    if alpha.getextrema()[0] < 250:
        return alpha.point(lambda value: 255 if value > 8 else 0).getbbox()

    background = Image.new(rgba.mode, rgba.size, rgba.getpixel((0, 0)))
    difference = ImageChops.difference(rgba, background)
    return difference.getbbox()


def crop_png_to_visible_content(path: Path) -> dict[str, object]:
    with Image.open(path) as source:
        rgba = source.convert("RGBA")
        bbox = visible_bbox(rgba)
        original_size = rgba.size

        if bbox is None:
            return {
                "file": str(path),
                "cropped": False,
                "original_size": original_size,
                "new_size": original_size,
                "reason": "no visible content detected",
            }

        cropped = rgba.crop(bbox)
        cropped.save(path, format="PNG")
        return {
            "file": str(path),
            "cropped": cropped.size != original_size,
            "original_size": original_size,
            "new_size": cropped.size,
            "bbox": bbox,
        }


def crop_rendered_orthophotos(output_dir: Path) -> list[dict[str, object]]:
    cropped_files = []
    face_suffixes = tuple(f"_{face}.png" for face in FACES)

    for path in sorted(output_dir.glob("*.png")):
        lower_name = path.name.lower()
        if "human_scale" in lower_name or not lower_name.endswith(face_suffixes):
            continue
        cropped_files.append(crop_png_to_visible_content(path))

    return cropped_files


def find_face_file(output_dir: Path, face: str) -> Path:
    matches = sorted(
        path for path in output_dir.glob("*.png")
        if path.name.lower().endswith(f"_{face}.png")
        and "human_scale" not in path.name.lower()
    )
    if not matches:
        raise FileNotFoundError(f"No orthophoto file found for face: {face}")
    return matches[0]


def image_size(path: Path) -> tuple[int, int]:
    with Image.open(path) as image:
        return image.size


def resize_png(path: Path, target_size: tuple[int, int]) -> dict[str, object]:
    target_width, target_height = target_size
    if target_width <= 0 or target_height <= 0:
        raise ValueError(f"Invalid target size for {path.name}: {target_size}")

    with Image.open(path) as source:
        rgba = source.convert("RGBA")
        original_size = rgba.size
        if original_size == target_size:
            return {
                "file": str(path),
                "resized": False,
                "original_size": original_size,
                "new_size": original_size,
            }

        resized = rgba.resize(target_size, Image.Resampling.LANCZOS)
        resized.save(path, format="PNG")
        return {
            "file": str(path),
            "resized": True,
            "original_size": original_size,
            "new_size": target_size,
        }


def normalize_orthophoto_dimensions(output_dir: Path) -> list[dict[str, object]]:
    front_path = find_face_file(output_dir, "front")
    back_path = find_face_file(output_dir, "back")
    right_path = find_face_file(output_dir, "right")
    left_path = find_face_file(output_dir, "left")
    top_path = find_face_file(output_dir, "top")

    front_width, front_height = image_size(front_path)
    right_width, right_height = image_size(right_path)
    if right_height <= 0:
        raise ValueError(f"Invalid right orthophoto height: {right_height}")

    normalized_right_width = max(1, round(right_width * (front_height / right_height)))
    right_size = (normalized_right_width, front_height)
    front_size = (front_width, front_height)
    top_size = (front_width, normalized_right_width)

    return [
        {
            "face": "front",
            "file": str(front_path),
            "resized": False,
            "original_size": front_size,
            "new_size": front_size,
            "role": "reference",
        },
        {"face": "back", **resize_png(back_path, front_size), "role": "match_front_width_height"},
        {"face": "right", **resize_png(right_path, right_size), "role": "match_front_height_keep_ratio"},
        {"face": "left", **resize_png(left_path, right_size), "role": "match_right_width_height"},
        {"face": "top", **resize_png(top_path, top_size), "role": "front_width_by_right_width"},
    ]


def load_mesh_bounds(model_path: Path) -> tuple[list[list[float]], dict[str, float]]:
    loaded = trimesh.load(model_path, force="scene", process=False)
    if isinstance(loaded, trimesh.Trimesh):
        mesh = loaded
    elif isinstance(loaded, trimesh.Scene):
        meshes = []
        for geometry_name, geometry in loaded.geometry.items():
            transform, _ = loaded.graph.get(geometry_name)
            mesh = geometry.copy()
            mesh.apply_transform(transform)
            meshes.append(mesh)
        if not meshes:
            raise RuntimeError("The GLB did not contain mesh geometry.")
        mesh = trimesh.util.concatenate(meshes)
    else:
        raise RuntimeError(f"Unsupported GLB load result: {type(loaded)!r}")

    bounds = mesh.bounds.astype(float).tolist()
    min_bounds, max_bounds = bounds
    dimensions = {
        "width_units": float(max_bounds[0] - min_bounds[0]),
        "height_units": float(max_bounds[1] - min_bounds[1]),
        "length_units": float(max_bounds[2] - min_bounds[2]),
    }
    return bounds, dimensions


def write_model_dimensions(model_path: Path, output_dir: Path) -> dict[str, object]:
    bounds, dimensions = load_mesh_bounds(model_path)
    payload = {
        "model": str(model_path),
        "unit_system": "GLB internal model units",
        "axis_mapping": {
            "width": "X axis, equivalent to front image width",
            "height": "Y axis, equivalent to front/back/left/right image height",
            "length": "Z axis, equivalent to right/left image width",
        },
        "bounds": {
            "min": bounds[0],
            "max": bounds[1],
        },
        **dimensions,
    }
    output_path = output_dir / MODEL_DIMENSIONS_NAME
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def main() -> int:
    args = build_parser().parse_args()
    source_model = Path(args.model).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    print("Orthophoto renderer started", flush=True)
    print(f"Model: {source_model}", flush=True)
    print(f"Output folder: {output_dir}", flush=True)
    print(f"Faces: {', '.join(FACES)}", flush=True)
    print("Dimensions: disabled", flush=True)

    renderer = load_renderer()
    renderer_args = SimpleNamespace(
        model=str(source_model),
        output_dir=str(output_dir),
        output_run_dir=str(output_dir),
        faces=FACES,
        width=args.width,
        height=args.height,
        padding=args.padding,
        target_width=args.target_width,
        wait_ms=args.wait_ms,
        retries=args.retries,
        retry_wait_step_ms=args.retry_wait_step_ms,
        min_file_size=args.min_file_size,
        show_box=args.show_box,
        dimensions=args.dimensions,
        browser=args.browser,
        keep_html=False,
    )
    manifest = renderer.render_faces(renderer_args)
    cropped_files = crop_rendered_orthophotos(output_dir)
    normalized_files = normalize_orthophoto_dimensions(output_dir)
    model_dimensions = write_model_dimensions(source_model, output_dir)

    print(f"Orthophoto status: {manifest['status']}", flush=True)
    print(f"Verified faces: {manifest['verified_faces']}", flush=True)
    print(f"Failed faces: {manifest['failed_faces']}", flush=True)
    print("Transparent padding crop:", flush=True)
    for item in cropped_files:
        print(
            f"  {Path(str(item['file'])).name}: "
            f"{item['original_size']} -> {item['new_size']}",
            flush=True,
        )
    print("Synchronized orthophoto dimensions:", flush=True)
    for item in normalized_files:
        print(
            f"  {item['face']}: "
            f"{Path(str(item['file'])).name}: "
            f"{item['original_size']} -> {item['new_size']} "
            f"({item['role']})",
            flush=True,
        )
    print("GLB model dimensions:", flush=True)
    print(
        "  "
        f"width={model_dimensions['width_units']:.6f}, "
        f"length={model_dimensions['length_units']:.6f}, "
        f"height={model_dimensions['height_units']:.6f} "
        "model units",
        flush=True,
    )
    return 0 if manifest["status"] in {"success", "partial"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
