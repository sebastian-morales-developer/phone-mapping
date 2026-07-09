#!/usr/bin/env python3
"""Clip the special Hyper3D top-only GLB into a single half.

This is intentionally narrow: it only runs for individual Hyper3D projects where
the only selected image view is top. Other projects are left untouched.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import trimesh


AXIS_NAMES = ("x", "y", "z")
VIEW_ALIASES = {
    "front": "front",
    "left_front": "left_front",
    "front_left": "left_front",
    "left": "left",
    "left_back": "left_back",
    "back_left": "left_back",
    "back": "back",
    "right_back": "right_back",
    "back_right": "right_back",
    "right": "right",
    "right_front": "right_front",
    "front_right": "right_front",
    "top": "top",
    "up": "top",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Clip a Hyper3D top-only GLB into a right-side half.")
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def normalize_view(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    token = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    token = re.sub(r"_edited$", "", token)
    if token in VIEW_ALIASES:
        return VIEW_ALIASES[token]
    for alias in sorted(VIEW_ALIASES, key=len, reverse=True):
        if token == alias or token.startswith(f"{alias}_") or token.endswith(f"_{alias}"):
            return VIEW_ALIASES[alias]
    return None


def view_from_record(record: Any) -> str | None:
    if isinstance(record, str):
        return normalize_view(Path(record).stem)
    if not isinstance(record, dict):
        return None

    for key in ("view", "field", "angle", "viewType", "view_type"):
        view = normalize_view(record.get(key))
        if view:
            return view

    for key in ("name", "file", "filename", "path", "savedPath", "inputPath", "originalName"):
        value = record.get(key)
        if isinstance(value, str):
            view = normalize_view(Path(value).stem)
            if view:
                return view

    return None


def manifest_views(manifest: dict[str, Any]) -> set[str]:
    for key in ("savedImages", "uploadedImages"):
        records = manifest.get(key)
        if not isinstance(records, list):
            continue
        views = {view for record in records if (view := view_from_record(record))}
        if views:
            return views
    return set()


def should_clip_top_only(manifest: dict[str, Any]) -> bool:
    if str(manifest.get("modelProvider", "")).lower() != "hyper3d":
        return False

    production_mode = str(manifest.get("productionMode", "")).lower()
    source = str(manifest.get("source", "")).lower()
    batch_mode = str(manifest.get("batchMode", "")).lower()
    inferred_individual = (
        not manifest.get("batchMode")
        and not manifest.get("batchSource")
        and isinstance(manifest.get("uploadedImages"), list)
    )
    supported_batch_sources = {"batch_by_model", "batch_hyper3d_raw"}
    supported_batch_modes = {"by_model", "hyper3d_raw"}
    if (
        production_mode != "individual"
        and source not in supported_batch_sources
        and batch_mode not in supported_batch_modes
        and not inferred_individual
    ):
        return False

    return manifest_views(manifest) == {"top"}


def loaded_to_mesh(loaded: Any) -> trimesh.Trimesh:
    if isinstance(loaded, trimesh.Trimesh):
        return loaded.copy()

    if not isinstance(loaded, trimesh.Scene):
        raise TypeError(f"Unsupported GLB object type: {type(loaded)!r}")

    meshes: list[trimesh.Trimesh] = []
    for node_name in loaded.graph.nodes_geometry:
        transform, geometry_name = loaded.graph.get(node_name)
        geometry = loaded.geometry.get(geometry_name)
        if geometry is None or not isinstance(geometry, trimesh.Trimesh):
            continue
        mesh = geometry.copy()
        mesh.apply_transform(transform)
        meshes.append(mesh)

    if not meshes:
        meshes = [geometry.copy() for geometry in loaded.geometry.values() if isinstance(geometry, trimesh.Trimesh)]

    if not meshes:
        raise ValueError("No mesh geometry found in GLB.")
    if len(meshes) == 1:
        return meshes[0]
    return trimesh.util.concatenate(meshes)


def clip_half(mesh: trimesh.Trimesh, cut_axis: int, keep_side: str) -> trimesh.Trimesh:
    if keep_side not in {"positive", "negative"}:
        raise ValueError(f"Unsupported keep side: {keep_side}")

    bounds = mesh.bounds
    center = bounds.mean(axis=0)
    side_sign = 1.0 if keep_side == "positive" else -1.0
    normal = np.zeros(3)
    normal[cut_axis] = side_sign

    clipped: trimesh.Trimesh | None = None
    try:
        sliced = mesh.slice_plane(plane_origin=center, plane_normal=normal, cap=False)
        if isinstance(sliced, trimesh.Trimesh) and len(sliced.faces) > 0:
            clipped = sliced
    except Exception as error:  # noqa: BLE001 - fallback keeps this post-process resilient.
        print(f"slice_plane failed, using face-centroid fallback: {error}", flush=True)

    if clipped is None:
        face_centers = mesh.triangles_center
        if keep_side == "positive":
            keep_faces = np.nonzero(face_centers[:, cut_axis] >= center[cut_axis])[0]
        else:
            keep_faces = np.nonzero(face_centers[:, cut_axis] <= center[cut_axis])[0]
        if not len(keep_faces):
            raise ValueError(f"No faces remained after top-only {keep_side} half clipping.")
        clipped = mesh.submesh([keep_faces], append=True, repair=False)

    return clipped


def main() -> int:
    args = parse_args()
    project_dir = args.project.expanduser().resolve()
    model_path = args.model.expanduser().resolve()
    manifest_path = project_dir / "project_manifest.json"

    if not manifest_path.exists():
        print(f"No project manifest found at {manifest_path}. Skipping top-only GLB clipping.", flush=True)
        return 0

    manifest = read_json(manifest_path)
    views = sorted(manifest_views(manifest))
    if not should_clip_top_only(manifest):
        print(f"Top-only Hyper3D clipping not needed. Detected views: {', '.join(views) or 'none'}", flush=True)
        return 0

    if not model_path.exists():
        raise FileNotFoundError(f"GLB file not found: {model_path}")

    print("Top-only Hyper3D project detected. Clipping GLB to one half before orthophotos.", flush=True)
    loaded = trimesh.load(model_path, force="scene", process=False)
    mesh = loaded_to_mesh(loaded)
    before_bounds = mesh.bounds
    extents = before_bounds[1] - before_bounds[0]
    axis_order = np.argsort(extents)
    cut_axis = int(axis_order[0])
    second_longest_axis = int(axis_order[1])
    longest_axis = int(axis_order[2])

    positive_half = clip_half(mesh, cut_axis=cut_axis, keep_side="positive")
    negative_half = clip_half(mesh, cut_axis=cut_axis, keep_side="negative")
    after_bounds = positive_half.bounds

    backup_path = model_path.with_suffix(model_path.suffix + ".top_only_full.bak")
    if not backup_path.exists():
        shutil.copy2(model_path, backup_path)

    negative_path = model_path.with_name(f"{model_path.stem}_top_only_negative{model_path.suffix}")
    positive_half.export(str(model_path))
    negative_half.export(str(negative_path))

    clip_metadata = {
        "applied": True,
        "appliedAt": datetime.now(timezone.utc).isoformat(),
        "sourceCondition": "individual_hyper3d_single_top_image",
        "glbPath": str(model_path),
        "positiveGlbPath": str(model_path),
        "negativeGlbPath": str(negative_path),
        "originalBackupPath": str(backup_path),
        "longestAxis": AXIS_NAMES[longest_axis],
        "secondLongestAxis": AXIS_NAMES[second_longest_axis],
        "cutAxis": AXIS_NAMES[cut_axis],
        "splitAxis": AXIS_NAMES[cut_axis],
        "keptSide": "positive",
        "capAdded": False,
        "boundsBefore": before_bounds.tolist(),
        "boundsAfter": after_bounds.tolist(),
        "negativeBoundsAfter": negative_half.bounds.tolist(),
        "extentsBefore": extents.tolist(),
        "extentsAfter": (after_bounds[1] - after_bounds[0]).tolist(),
        "negativeExtentsAfter": (negative_half.bounds[1] - negative_half.bounds[0]).tolist(),
    }

    manifest["topOnlyHyper3dClip"] = clip_metadata
    write_json(manifest_path, manifest)
    write_json(project_dir / "output_glb" / "top_only_clip_manifest.json", clip_metadata)

    print(
        "Top-only Hyper3D GLB clipped. "
        f"Longest axis: {AXIS_NAMES[longest_axis]}, "
        f"second-longest axis: {AXIS_NAMES[second_longest_axis]}, "
        f"cut axis: {AXIS_NAMES[cut_axis]}, no cap added, "
        f"negative side saved: {negative_path}, "
        f"backup: {backup_path}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
