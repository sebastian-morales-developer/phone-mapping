#!/usr/bin/env python3
"""Create a front orthophoto with a deterministic human scale marker."""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI
from PIL import Image, ImageChops, ImageDraw


APP_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_NAME = "human_scale_front.png"
METADATA_NAME = "human_scale_front_metadata.json"

FLOOR_HEIGHT_RATIOS = {
    1: 0.30,
    2: 0.22,
    3: 0.16,
    4: 0.13,
}
PERSON_HEIGHT_M = 1.70
REFERENCE_HEIGHTS_M = {
    "front_door": 2.05,
    "garage_door": 2.25,
    "first_floor": 2.75,
}
REFERENCE_PRIORITY = ("front_door", "garage_door", "first_floor", "floor_count_fallback")


@dataclass(frozen=True)
class VisibleBounds:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return self.right - self.left + 1

    @property
    def height(self) -> int:
        return self.bottom - self.top + 1

    def as_crop_box(self) -> tuple[int, int, int, int]:
        return (self.left, self.top, self.right + 1, self.bottom + 1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a human scale marker image.")
    parser.add_argument("--orthophotos-dir", required=True, type=Path)
    parser.add_argument("--analysis-model", default=os.getenv("OPENAI_HUMAN_SCALE_ANALYSIS_MODEL", "gpt-4.1-mini"))
    parser.add_argument("--fallback-floors", default=2, type=int)
    parser.add_argument("--skip-openai-analysis", action="store_true")
    return parser.parse_args()


def find_front_image(folder: Path) -> Path:
    candidates = sorted(
        path for path in folder.glob("*.png")
        if "_front" in path.stem.lower()
        and "human_scale" not in path.stem.lower()
    )
    if not candidates:
        raise FileNotFoundError(f"No front orthophoto PNG found in {folder}")
    return candidates[0]


def find_face_image(folder: Path, face: str) -> Path:
    candidates = sorted(
        path for path in folder.glob("*.png")
        if path.name.lower().endswith(f"_{face}.png")
        and "human_scale" not in path.stem.lower()
    )
    if not candidates:
        raise FileNotFoundError(f"No {face} orthophoto PNG found in {folder}")
    return candidates[0]


def visible_bounds(image: Image.Image) -> VisibleBounds:
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    bbox = None

    if alpha.getextrema()[0] < 250:
        bbox = alpha.point(lambda value: 255 if value > 8 else 0).getbbox()

    if bbox is None:
        # Fallback for images without meaningful alpha: trim against the corner
        # color so black/white canvas padding does not drive the scale.
        background = Image.new(rgba.mode, rgba.size, rgba.getpixel((0, 0)))
        difference = ImageChops.difference(rgba, background)
        bbox = difference.getbbox()

    if bbox is None:
        raise RuntimeError("Could not detect visible pixels in the front orthophoto.")

    left, top, right, bottom = bbox
    return VisibleBounds(left=left, top=top, right=right - 1, bottom=bottom - 1)


def crop_to_visible_content(image: Image.Image) -> tuple[Image.Image, VisibleBounds]:
    bounds = visible_bounds(image)
    return image.convert("RGBA").crop(bounds.as_crop_box()), bounds


def extract_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip()
    cleaned = re.sub(r"```$", "", cleaned).strip()
    match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
    if not match:
        raise ValueError("No JSON object found in OpenAI response.")
    return json.loads(match.group(0))


def image_to_base64_png(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.convert("RGBA").save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def normalize_reference_type(value: Any) -> str:
    reference_type = str(value or "floor_count_fallback").strip().lower().replace("-", "_")
    aliases = {
        "door": "front_door",
        "pedestrian_door": "front_door",
        "entry_door": "front_door",
        "main_door": "front_door",
        "garage": "garage_door",
        "garage_portal": "garage_door",
        "story_height": "first_floor",
        "floor_height": "first_floor",
        "floor_count": "floor_count_fallback",
        "none": "floor_count_fallback",
    }
    reference_type = aliases.get(reference_type, reference_type)
    if reference_type not in REFERENCE_PRIORITY:
        return "floor_count_fallback"
    return reference_type


def analyze_scale_with_openai(image: Image.Image, model: str) -> dict[str, Any]:
    encoded = image_to_base64_png(image)
    client = OpenAI()
    response = client.responses.create(
        model=model,
        input=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            "Analyze this cropped orthographic front elevation PNG of a residential building. "
                            "We need to draw a 1.70 meter human scale marker. Return only JSON. "
                            "Use this strict reference hierarchy: first choose front_door if a pedestrian "
                            "entry door is visible and measurable; otherwise choose garage_door if a garage "
                            "door is visible and measurable; otherwise choose first_floor if the first-floor "
                            "height from ground/base line to the next floor/roof/eave is reasonably visible; "
                            "otherwise choose floor_count_fallback. Do not use windows as the main reference. "
                            "Return these fields: "
                            "reference_type as one of front_door, garage_door, first_floor, floor_count_fallback; "
                            "visible_floors as an integer from 1 to 4; "
                            "confidence as a number from 0 to 1 for the chosen reference; "
                            "reference_height_px as the estimated pixel height of the chosen reference in this image, "
                            "or null for floor_count_fallback; "
                            "reference_top_y and reference_bottom_y as approximate pixel y-coordinates, or null; "
                            "assumed_reference_height_m using 2.05 for front_door, 2.25 for garage_door, "
                            "2.75 for first_floor, or null for fallback; "
                            "estimated_person_height_px as reference_height_px * 1.70 / assumed_reference_height_m, "
                            "or null for fallback; "
                            "reason as a short sentence. "
                            "Count above-grade residential levels only. Do not count attic gables, roof volume, "
                            "chimney, basement trim, porch roof, or railings as floors."
                        ),
                    },
                    {
                        "type": "input_image",
                        "image_url": f"data:image/png;base64,{encoded}",
                    },
                ],
            }
        ],
    )
    payload = extract_json(response.output_text)
    payload["reference_type"] = normalize_reference_type(payload.get("reference_type"))
    floors = int(payload.get("visible_floors", 2))
    payload["visible_floors"] = max(1, min(4, floors))
    return payload


def ratio_for_floor_count(floors: int) -> float:
    floors = max(1, min(4, floors))
    return FLOOR_HEIGHT_RATIOS.get(floors, FLOOR_HEIGHT_RATIOS[2])


def fallback_height_for_floors(image_height: int, floors: int) -> dict[str, Any]:
    ratio = ratio_for_floor_count(floors)
    return {
        "height_px": round(image_height * ratio),
        "height_ratio": ratio,
        "source": "floor_count_fallback",
        "reference_type": "floor_count_fallback",
    }


def number_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    return number


def resolve_person_height(image_size: tuple[int, int], analysis: dict[str, Any]) -> dict[str, Any]:
    _width, height = image_size
    floors = int(analysis.get("visible_floors", 2))
    fallback = fallback_height_for_floors(height, floors)
    reference_type = normalize_reference_type(analysis.get("reference_type"))
    confidence = number_or_none(analysis.get("confidence")) or 0

    min_height = max(58, round(height * 0.10))
    max_height = round(height * 0.40)

    if reference_type in REFERENCE_HEIGHTS_M and confidence >= 0.50:
        reference_height_px = number_or_none(analysis.get("reference_height_px"))
        assumed_height_m = number_or_none(analysis.get("assumed_reference_height_m"))
        assumed_height_m = assumed_height_m or REFERENCE_HEIGHTS_M[reference_type]

        if reference_height_px and reference_height_px >= 70:
            raw_height = round(reference_height_px * PERSON_HEIGHT_M / assumed_height_m)
            clamped_height = max(min_height, min(raw_height, max_height))
            return {
                "height_px": clamped_height,
                "raw_height_px": raw_height,
                "height_ratio": clamped_height / height,
                "source": "architectural_reference",
                "reference_type": reference_type,
                "reference_height_px": reference_height_px,
                "assumed_reference_height_m": assumed_height_m,
                "confidence": confidence,
                "clamped": clamped_height != raw_height,
            }

    return {
        **fallback,
        "confidence": confidence,
        "fallback_reason": (
            "No reliable architectural reference was returned."
            if reference_type == "floor_count_fallback"
            else f"Reference {reference_type} was below confidence or size thresholds."
        ),
    }


def marker_geometry(image_size: tuple[int, int], person_height: dict[str, Any]) -> dict[str, int | float | str | bool]:
    width, height = image_size
    marker_height = round(float(person_height["height_px"]))
    marker_height = max(80, min(marker_height, round(height * 0.34)))
    marker_width = round(marker_height * 0.42)
    marker_width = max(42, min(marker_width, round(width * 0.18)))

    center_x = width // 2
    left = max(0, center_x - marker_width // 2)
    right = min(width - 1, left + marker_width)
    left = max(0, right - marker_width)

    bottom = height - 1
    top = max(0, bottom - marker_height)

    return {
        "left": left,
        "top": top,
        "right": right,
        "bottom": bottom,
        "width": right - left + 1,
        "height": bottom - top + 1,
        "height_ratio": marker_height / height,
        "scale_source": str(person_height["source"]),
        "reference_type": str(person_height["reference_type"]),
    }


def draw_human_marker(image: Image.Image, geometry: dict[str, int | float]) -> Image.Image:
    output = image.convert("RGBA").copy()
    draw = ImageDraw.Draw(output, "RGBA")

    left = int(geometry["left"])
    top = int(geometry["top"])
    right = int(geometry["right"])
    bottom = int(geometry["bottom"])
    marker_w = right - left + 1
    marker_h = bottom - top + 1

    red = (255, 45, 28, 238)
    white = (255, 255, 255, 255)

    draw.rectangle([left, top, right, bottom], fill=red)

    cx = (left + right) // 2
    padding = max(4, round(marker_w * 0.10))
    head_radius = max(6, round(marker_w * 0.14))
    head_cy = top + padding + head_radius
    draw.ellipse(
        [cx - head_radius, head_cy - head_radius, cx + head_radius, head_cy + head_radius],
        fill=white,
    )

    body_top = head_cy + head_radius + padding
    foot_bottom = bottom - padding
    leg_gap = max(3, round(marker_w * 0.08))
    leg_w = max(6, round(marker_w * 0.16))
    arm_w = max(5, round(marker_w * 0.10))
    torso_w = max(12, round(marker_w * 0.30))
    torso_bottom = top + round(marker_h * 0.69)

    draw.rectangle(
        [cx - torso_w // 2, body_top, cx + torso_w // 2, torso_bottom],
        fill=white,
    )
    draw.rectangle(
        [left + padding, body_top + round(marker_h * 0.05), left + padding + arm_w, torso_bottom],
        fill=white,
    )
    draw.rectangle(
        [right - padding - arm_w, body_top + round(marker_h * 0.05), right - padding, torso_bottom],
        fill=white,
    )
    draw.rectangle(
        [cx - leg_gap // 2 - leg_w, torso_bottom, cx - leg_gap // 2, foot_bottom],
        fill=white,
    )
    draw.rectangle(
        [cx + leg_gap // 2, torso_bottom, cx + leg_gap // 2 + leg_w, foot_bottom],
        fill=white,
    )

    return output


def write_metadata(path: Path, metadata: dict[str, Any]) -> None:
    path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")


def calculate_building_dimensions(
    *,
    front_width_px: int,
    front_height_px: int,
    right_width_px: int,
    right_height_px: int,
    human_height_px: int,
) -> dict[str, Any]:
    if human_height_px <= 0:
        raise ValueError("Human marker height must be greater than zero.")

    pixels_per_meter = human_height_px / PERSON_HEIGHT_M
    front_width_m = front_width_px / pixels_per_meter
    building_length_m = right_width_px / pixels_per_meter

    return {
        "method": "human_scale_marker_pixel_ratio",
        "person_height_m": PERSON_HEIGHT_M,
        "person_height_px": human_height_px,
        "pixels_per_meter": pixels_per_meter,
        "meters_per_pixel": 1 / pixels_per_meter,
        "front_image_size_px": [front_width_px, front_height_px],
        "right_image_size_px": [right_width_px, right_height_px],
        "front_width_m": front_width_m,
        "building_length_m": building_length_m,
        "people_across_front": front_width_px / human_height_px,
        "people_across_right": right_width_px / human_height_px,
    }


def main() -> int:
    load_dotenv(APP_ROOT / ".env", override=True)
    args = parse_args()
    orthophotos_dir = args.orthophotos_dir.expanduser().resolve()
    output_path = orthophotos_dir / OUTPUT_NAME
    metadata_path = orthophotos_dir / METADATA_NAME

    if output_path.exists():
        print(f"Human scale image already exists: {output_path}", flush=True)
        return 0

    front_path = find_front_image(orthophotos_dir)
    right_path = find_face_image(orthophotos_dir, "right")
    print("Human scale generation started", flush=True)
    print(f"Front orthophoto: {front_path}", flush=True)
    print(f"Right orthophoto: {right_path}", flush=True)
    print(f"Output image: {output_path}", flush=True)
    print("Method: OpenAI floor analysis + deterministic PNG overlay", flush=True)

    with Image.open(front_path) as source:
        source_rgba = source.convert("RGBA")
        cropped, bounds = crop_to_visible_content(source_rgba)

    print(f"Original size: {source_rgba.width}x{source_rgba.height}", flush=True)
    print(
        "Visible bounds: "
        f"left={bounds.left}, top={bounds.top}, right={bounds.right}, bottom={bounds.bottom}",
        flush=True,
    )
    print(f"Cropped size: {cropped.width}x{cropped.height}", flush=True)

    analysis: dict[str, Any] = {
        "reference_type": "floor_count_fallback",
        "visible_floors": max(1, min(4, args.fallback_floors)),
        "confidence": 0,
        "reference_height_px": None,
        "reference_top_y": None,
        "reference_bottom_y": None,
        "assumed_reference_height_m": None,
        "estimated_person_height_px": None,
        "reason": "Fallback floor count.",
        "source": "fallback",
    }

    if args.skip_openai_analysis:
        print("OpenAI scale analysis skipped by CLI option.", flush=True)
    elif not os.getenv("OPENAI_API_KEY"):
        print("OPENAI_API_KEY is not available. Using fallback floor count.", flush=True)
    else:
        try:
            print(f"OpenAI analysis model: {args.analysis_model}", flush=True)
            analysis = analyze_scale_with_openai(cropped, args.analysis_model)
            analysis["source"] = "openai"
            print(
                "OpenAI scale analysis: "
                f"reference={analysis.get('reference_type')}, "
                f"floors={analysis['visible_floors']}, "
                f"confidence={analysis.get('confidence', 'n/a')}",
                flush=True,
            )
            if analysis.get("reference_height_px"):
                print(
                    "OpenAI reference height: "
                    f"{analysis.get('reference_height_px')} px "
                    f"-> person={analysis.get('estimated_person_height_px')} px",
                    flush=True,
                )
        except Exception as error:  # noqa: BLE001 - keep UI workflow alive.
            print(f"OpenAI scale analysis failed: {error}", flush=True)
            print("Using fallback floor count.", flush=True)

    person_height = resolve_person_height(cropped.size, analysis)
    print(
        "Resolved person height: "
        f"{person_height['height_px']} px "
        f"via {person_height['source']} "
        f"({person_height['reference_type']})",
        flush=True,
    )
    if person_height.get("fallback_reason"):
        print(f"Fallback reason: {person_height['fallback_reason']}", flush=True)

    geometry = marker_geometry(cropped.size, person_height)
    with Image.open(right_path) as right_source:
        right_size = right_source.size
    building_dimensions = calculate_building_dimensions(
        front_width_px=cropped.width,
        front_height_px=cropped.height,
        right_width_px=right_size[0],
        right_height_px=right_size[1],
        human_height_px=int(geometry["height"]),
    )
    print(
        "Marker geometry: "
        f"x={geometry['left']}..{geometry['right']}, "
        f"y={geometry['top']}..{geometry['bottom']}, "
        f"height_ratio={geometry['height_ratio']:.4f}",
        flush=True,
    )
    print("Marker bottom is aligned to cropped PNG bottom edge.", flush=True)
    print(
        "Estimated building dimensions: "
        f"front_width={building_dimensions['front_width_m']:.3f} m, "
        f"length={building_dimensions['building_length_m']:.3f} m, "
        f"pixels_per_meter={building_dimensions['pixels_per_meter']:.3f}",
        flush=True,
    )

    result = draw_human_marker(cropped, geometry)
    result.save(output_path, format="PNG")

    write_metadata(
        metadata_path,
        {
            "front_image": str(front_path),
            "right_image": str(right_path),
            "output_image": str(output_path),
            "original_size": [source_rgba.width, source_rgba.height],
            "visible_bounds": bounds.__dict__,
            "cropped_size": [cropped.width, cropped.height],
            "analysis": analysis,
            "scale_calculation": person_height,
            "marker_geometry": geometry,
            "building_dimensions": building_dimensions,
            "transparent_background": True,
        },
    )

    print("Human scale image created successfully", flush=True)
    print("Saved as PNG with transparent background", flush=True)
    print(f"Saved: {output_path}", flush=True)
    print(f"Metadata: {metadata_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
