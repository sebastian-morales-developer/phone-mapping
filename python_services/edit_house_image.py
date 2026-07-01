#!/usr/bin/env python3
"""Edit a property photo with the OpenAI Images API and save a timestamped copy."""

from __future__ import annotations

import argparse
import base64
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
from PIL import Image, ImageDraw, ImageFont


DEFAULT_PROMPT = """
Edit the input photo while preserving the same house, camera angle, perspective,
lighting, shadows, architectural proportions, and realistic photo style.

Remove trees, shrubs, garden overgrowth, vehicles, tarps, plastic covers,
basketball hoops, furniture, and any unrelated objects that obstruct the visual
of the house facade. Reconstruct hidden parts of the facade naturally and
photorealistically so the building remains believable and consistent with the
original image. Keep the scene clean, open, and realistic.
""".strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Process a house photo with OpenAI image editing."
    )
    parser.add_argument(
        "image",
        type=Path,
        help="Input image path, for example PHOTO_REPORTS_READY/.../front-right.jpg",
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
        "--output-dir",
        type=Path,
        default=Path("outputs") / "outputs_individuals",
        help="Directory where timestamped output images are saved.",
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
        help="Output file format.",
    )
    return parser.parse_args()


def build_output_path(input_path: Path, output_dir: Path, output_format: str) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = input_path.stem.replace(" ", "_")
    return output_dir / f"{timestamp}_{stem}_edited.{output_format}"


def build_comparison_output_path(output_path: Path) -> Path:
    return output_path.with_name(output_path.stem.replace("_edited", "_comparison") + ".png")


def build_prompt(prompt: str, prompt_file: Path | None) -> str:
    if not prompt_file:
        return prompt

    prompt_path = prompt_file.expanduser()
    if not prompt_path.is_file():
        raise FileNotFoundError(f"Prompt file not found: {prompt_path}")
    return prompt_path.read_text(encoding="utf-8").strip()


def load_label_font(image_height: int) -> ImageFont.ImageFont:
    font_size = max(18, image_height // 38)
    for font_path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    ):
        try:
            return ImageFont.truetype(font_path, font_size)
        except OSError:
            continue
    return ImageFont.load_default()


def add_corner_label(image: Image.Image, label: str) -> None:
    draw = ImageDraw.Draw(image)
    font = load_label_font(image.height)
    padding_x = max(10, image.width // 80)
    padding_y = max(6, image.height // 120)
    margin = max(12, image.height // 80)
    text_box = draw.textbbox((0, 0), label, font=font)
    text_width = text_box[2] - text_box[0]
    text_height = text_box[3] - text_box[1]
    box = (
        margin,
        margin,
        margin + text_width + padding_x * 2,
        margin + text_height + padding_y * 2,
    )
    draw.rounded_rectangle(box, radius=3, fill=(0, 0, 0))
    draw.text(
        (margin + padding_x, margin + padding_y),
        label,
        fill=(255, 255, 255),
        font=font,
    )


def resize_to_height(image: Image.Image, target_height: int) -> Image.Image:
    target_width = round(image.width * (target_height / image.height))
    return image.resize((target_width, target_height), Image.Resampling.LANCZOS)


def create_comparison_image(
    original_path: Path,
    edited_path: Path,
    comparison_path: Path,
) -> None:
    with Image.open(original_path) as original_file, Image.open(edited_path) as edited_file:
        edited = edited_file.convert("RGB")
        original = resize_to_height(original_file.convert("RGB"), edited.height)

    add_corner_label(original, "Original")
    add_corner_label(edited, "Edited with AI")

    divider_width = max(8, edited.height // 100)
    divider_color = (128, 0, 255)
    comparison = Image.new(
        "RGB",
        (original.width + divider_width + edited.width, edited.height),
        divider_color,
    )
    comparison.paste(original, (0, 0))
    comparison.paste(edited, (original.width + divider_width, 0))
    comparison.save(comparison_path)


def edit_image_with_openai(
    client: OpenAI,
    input_path: Path,
    output_path: Path,
    prompt: str,
    model: str,
    size: str,
    quality: str,
    output_format: str,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with input_path.open("rb") as image_file:
        result = client.images.edit(
            model=model,
            image=image_file,
            prompt=prompt,
            size=size,
            quality=quality,
            output_format=output_format,
        )

    image_base64 = result.data[0].b64_json
    if not image_base64:
        raise RuntimeError("The API response did not include image data.")

    output_path.write_bytes(base64.b64decode(image_base64))


def process_image(
    client: OpenAI,
    input_path: Path,
    edited_path: Path,
    comparison_path: Path,
    prompt: str,
    model: str,
    size: str,
    quality: str,
    output_format: str,
) -> tuple[Path, Path]:
    edit_image_with_openai(
        client=client,
        input_path=input_path,
        output_path=edited_path,
        prompt=prompt,
        model=model,
        size=size,
        quality=quality,
        output_format=output_format,
    )
    comparison_path.parent.mkdir(parents=True, exist_ok=True)
    create_comparison_image(input_path, edited_path, comparison_path)
    return edited_path, comparison_path


def main() -> int:
    load_dotenv()
    args = parse_args()

    input_path = args.image.expanduser()
    if not input_path.is_file():
        print(f"Input image not found: {input_path}", file=sys.stderr)
        return 1

    try:
        prompt = build_prompt(args.prompt, args.prompt_file)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    output_dir = args.output_dir.expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = build_output_path(input_path, output_dir, args.output_format)
    comparison_path = build_comparison_output_path(output_path)

    client = OpenAI()
    try:
        process_image(
            client=client,
            input_path=input_path,
            edited_path=output_path,
            comparison_path=comparison_path,
            prompt=prompt,
            model=args.model,
            size=args.size,
            quality=args.quality,
            output_format=args.output_format,
        )
    except Exception as exc:
        print(f"Image processing failed: {exc}", file=sys.stderr)
        return 1

    print(f"Edited: {output_path}")
    print(f"Comparison: {comparison_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
