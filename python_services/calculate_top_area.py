#!/usr/bin/env python3
"""Estimate the real 3D area visible from the top orthographic view of a GLB."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import trimesh


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Estimate visible top-view surface area for a GLB.")
    parser.add_argument("--model", required=True, type=Path, help="Path to the GLB file.")
    parser.add_argument("--output", required=True, type=Path, help="Path to write JSON results.")
    parser.add_argument("--resolution", type=int, default=700, help="Max grid dimension for visibility sampling.")
    parser.add_argument("--normal-epsilon", type=float, default=0.025, help="Minimum upward normal component.")
    return parser


def load_mesh(model_path: Path) -> trimesh.Trimesh:
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

    if mesh.faces.size == 0 or mesh.vertices.size == 0:
        raise RuntimeError("The GLB mesh has no vertices or faces.")
    return mesh


def barycentric_xy(
    point: tuple[float, float],
    a: np.ndarray,
    b: np.ndarray,
    c: np.ndarray,
) -> tuple[float, float, float] | None:
    px, pz = point
    ax, az = a
    bx, bz = b
    cx, cz = c
    denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if abs(denominator) < 1e-12:
        return None
    w0 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / denominator
    w1 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / denominator
    w2 = 1.0 - w0 - w1
    tolerance = -1e-9
    if w0 < tolerance or w1 < tolerance or w2 < tolerance:
        return None
    return w0, w1, w2


def estimate_top_visible_area(mesh: trimesh.Trimesh, resolution: int, normal_epsilon: float) -> dict[str, object]:
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    triangles = vertices[faces]
    normals = np.asarray(mesh.face_normals, dtype=np.float64)
    face_areas = np.asarray(mesh.area_faces, dtype=np.float64)

    upward_faces = np.where(normals[:, 1] > normal_epsilon)[0]
    if upward_faces.size == 0:
        raise RuntimeError("No upward-facing triangles were found for the top-view area estimate.")

    bounds = mesh.bounds
    min_x, max_x = float(bounds[0][0]), float(bounds[1][0])
    min_z, max_z = float(bounds[0][2]), float(bounds[1][2])
    span_x = max_x - min_x
    span_z = max_z - min_z
    if span_x <= 0 or span_z <= 0:
        raise RuntimeError("The mesh has invalid X/Z bounds for top projection.")

    max_span = max(span_x, span_z)
    columns = max(1, int(math.ceil(resolution * span_x / max_span)))
    rows = max(1, int(math.ceil(resolution * span_z / max_span)))
    cell_x = span_x / columns
    cell_z = span_z / rows

    top_y = np.full((rows, columns), -np.inf, dtype=np.float64)
    top_face = np.full((rows, columns), -1, dtype=np.int64)

    for face_index in upward_faces:
        triangle = triangles[face_index]
        projected = triangle[:, [0, 2]]
        tri_min_x = float(np.min(projected[:, 0]))
        tri_max_x = float(np.max(projected[:, 0]))
        tri_min_z = float(np.min(projected[:, 1]))
        tri_max_z = float(np.max(projected[:, 1]))

        col_start = max(0, int(math.floor((tri_min_x - min_x) / cell_x)))
        col_end = min(columns - 1, int(math.floor((tri_max_x - min_x) / cell_x)))
        row_start = max(0, int(math.floor((tri_min_z - min_z) / cell_z)))
        row_end = min(rows - 1, int(math.floor((tri_max_z - min_z) / cell_z)))

        a, b, c = projected
        y_values = triangle[:, 1]

        for row in range(row_start, row_end + 1):
            sample_z = min_z + (row + 0.5) * cell_z
            for col in range(col_start, col_end + 1):
                sample_x = min_x + (col + 0.5) * cell_x
                weights = barycentric_xy((sample_x, sample_z), a, b, c)
                if weights is None:
                    continue
                y = weights[0] * y_values[0] + weights[1] * y_values[1] + weights[2] * y_values[2]
                if y > top_y[row, col]:
                    top_y[row, col] = y
                    top_face[row, col] = face_index

    visible_cells = top_face >= 0
    visible_cell_count = int(np.count_nonzero(visible_cells))
    if visible_cell_count == 0:
        raise RuntimeError("The top-view visibility grid did not hit any triangles.")

    unique_faces, cell_counts = np.unique(top_face[visible_cells], return_counts=True)
    projected_area = visible_cell_count * cell_x * cell_z
    cell_area = cell_x * cell_z
    visible_area = float(np.sum(cell_area / normals[top_face[visible_cells], 1]))
    face_breakdown = []

    for face_index, visible_count in zip(unique_faces, cell_counts, strict=False):
        face_index = int(face_index)
        contribution = float(visible_count * cell_area / normals[face_index][1])
        face_breakdown.append(
            {
                "face_index": face_index,
                "mesh_area": float(face_areas[face_index]),
                "visible_cell_count": int(visible_count),
                "visible_area": contribution,
                "projected_visible_area": float(visible_count * cell_area),
                "normal_y": float(normals[face_index][1]),
            }
        )

    return {
        "method": "top_orthographic_visibility_grid",
        "area_units_squared": visible_area,
        "projected_area_units_squared": projected_area,
        "visible_cell_count": visible_cell_count,
        "grid": {
            "columns": columns,
            "rows": rows,
            "cell_width_units": cell_x,
            "cell_depth_units": cell_z,
            "requested_resolution": resolution,
        },
        "mesh": {
            "vertex_count": int(len(vertices)),
            "face_count": int(len(faces)),
            "upward_candidate_faces": int(len(upward_faces)),
            "visible_faces": int(len(unique_faces)),
            "bounds": bounds.tolist(),
            "span_x": span_x,
            "span_z": span_z,
        },
        "filters": {
            "normal_epsilon": normal_epsilon,
            "up_axis": "Y",
            "projection_plane": "X/Z",
        },
        "face_breakdown_top_50": sorted(face_breakdown, key=lambda item: item["visible_area"], reverse=True)[:50],
    }


def main() -> int:
    args = build_parser().parse_args()
    model_path = args.model.expanduser().resolve()
    output_path = args.output.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print("Top area estimation started", flush=True)
    print(f"Model: {model_path}", flush=True)
    print(f"Output: {output_path}", flush=True)
    print(f"Resolution: {args.resolution}", flush=True)

    mesh = load_mesh(model_path)
    result = estimate_top_visible_area(mesh, args.resolution, args.normal_epsilon)
    result["model"] = str(model_path)
    output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print(f"Visible top 3D area: {result['area_units_squared']:.6f} model units^2", flush=True)
    print(f"Projected top area: {result['projected_area_units_squared']:.6f} model units^2", flush=True)
    print(f"Visible faces: {result['mesh']['visible_faces']}", flush=True)
    print(f"Saved: {output_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
