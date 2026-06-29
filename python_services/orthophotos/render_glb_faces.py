"""
Render six orthographic face views from a GLB model without Python packages.

This script uses only the Python standard library. Rendering is delegated to an
installed Chromium-based browser in headless mode, using a temporary Three.js
page served from this project folder.
"""

from __future__ import annotations

import argparse
import base64
import csv
from datetime import datetime
import functools
import http.server
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]
TEMP_RENDERER_NAME = "_six_face_renderer.html"
FACES = ("front", "back", "right", "left", "top", "bottom")


HTML_TEMPLATE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>GLB Face Renderer</title>
    <style>
      html, body, #scene {{
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: transparent;
      }}

      #status {{
        position: fixed;
        left: 16px;
        top: 16px;
        z-index: 2;
        color: #111827;
        font: 700 14px Arial, sans-serif;
      }}
    </style>
    <script type="importmap">
      {{
        "imports": {{
          "three": "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js",
          "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/"
        }}
      }}
    </script>
  </head>
  <body>
    <div id="status">Loading GLB...</div>
    <canvas id="scene"></canvas>
    <canvas id="output"></canvas>
    <script>
      window.addEventListener("error", (event) => {
        const status = document.querySelector("#status");
        if (status) status.textContent = `JavaScript error: ${event.message}`;
      });

      window.addEventListener("unhandledrejection", (event) => {
        const status = document.querySelector("#status");
        if (status) status.textContent = `Promise error: ${event.reason}`;
      });
    </script>
    <script type="module">
      import * as THREE from "three";
      import {{ GLTFLoader }} from "three/addons/loaders/GLTFLoader.js";

      const params = new URLSearchParams(window.location.search);
      const modelUrl = params.get("model");
      const face = params.get("face") || "front";
      const padding = Number(params.get("padding") || "1.08");
      const targetWidth = Number(params.get("targetWidth") || "10");
      const showBox = params.get("showBox") === "1";
      const showDimensions = params.get("dimensions") !== "0";

      const DIAGONAL_COMPONENT_MIN_ANGLE_DEGREES = 5;
      const DIAGONAL_COMPONENT_MAX_ANGLE_DEGREES = 85;
      const DIAGONAL_COMPONENT_MIN_UNITS = 0.35;
      const SHOW_DIMENSION_VALUE_LABELS = false;
      const SHOW_BETA_ANGLE_LABELS = false;
      const ROOF_PITCH_TABLE = __ROOF_PITCH_TABLE_JSON__;
      const SUBSCRIPT_DIGITS = {{
        "0": "\\u2080",
        "1": "\\u2081",
        "2": "\\u2082",
        "3": "\\u2083",
        "4": "\\u2084",
        "5": "\\u2085",
        "6": "\\u2086",
        "7": "\\u2087",
        "8": "\\u2088",
        "9": "\\u2089"
      }};

      const canvas = document.querySelector("#scene");
      const outputCanvas = document.querySelector("#output");
      const outputContext = outputCanvas.getContext("2d");
      const status = document.querySelector("#status");

      const renderer = new THREE.WebGLRenderer({{
        canvas,
        antialias: true,
        alpha: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        powerPreference: "high-performance"
      }});
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(1);
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      outputCanvas.width = window.innerWidth;
      outputCanvas.height = window.innerHeight;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;

      const scene = new THREE.Scene();
      scene.background = null;

      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);

      const ambient = new THREE.HemisphereLight(0xffffff, 0x697066, 2.4);
      scene.add(ambient);

      const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
      keyLight.position.set(6, 12, 10);
      scene.add(keyLight);

      const fillLight = new THREE.DirectionalLight(0xffffff, 1.2);
      fillLight.position.set(-8, 6, -10);
      scene.add(fillLight);

      function normalizeModelToAppScale(model) {{
        if (!targetWidth || targetWidth <= 0) return;

        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);

        const maxXZ = Math.max(size.x, size.z);
        const scale = maxXZ > 0 ? targetWidth / maxXZ : 1;
        model.scale.setScalar(scale);

        const scaledBox = new THREE.Box3().setFromObject(model);
        const scaledCenter = new THREE.Vector3();
        scaledBox.getCenter(scaledCenter);

        model.position.x -= scaledCenter.x;
        model.position.z -= scaledCenter.z;
        model.position.y -= scaledBox.min.y;
      }}

      function getFaceSetup(faceName, box, size, center, distance) {{
        const setups = {{
          front: {{
            position: new THREE.Vector3(center.x, center.y, box.max.z + distance),
            up: new THREE.Vector3(0, 1, 0),
            width: size.x,
            height: size.y
          }},
          back: {{
            position: new THREE.Vector3(center.x, center.y, box.min.z - distance),
            up: new THREE.Vector3(0, 1, 0),
            width: size.x,
            height: size.y
          }},
          right: {{
            position: new THREE.Vector3(box.max.x + distance, center.y, center.z),
            up: new THREE.Vector3(0, 1, 0),
            width: size.z,
            height: size.y
          }},
          left: {{
            position: new THREE.Vector3(box.min.x - distance, center.y, center.z),
            up: new THREE.Vector3(0, 1, 0),
            width: size.z,
            height: size.y
          }},
          top: {{
            position: new THREE.Vector3(center.x, box.max.y + distance, center.z),
            up: new THREE.Vector3(0, 0, -1),
            width: size.x,
            height: size.z
          }},
          bottom: {{
            position: new THREE.Vector3(center.x, box.min.y - distance, center.z),
            up: new THREE.Vector3(0, 0, 1),
            width: size.x,
            height: size.z
          }}
        }};

        return setups[faceName] || setups.front;
      }}

      function frameOrthographicCamera(faceName, box) {{
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        const maxDim = Math.max(size.x, size.y, size.z, 1);
        const distance = maxDim * 3;
        const setup = getFaceSetup(faceName, box, size, center, distance);
        const aspect = window.innerWidth / window.innerHeight;
        const targetAspect = setup.width / setup.height;

        const framePadding = showDimensions ? Math.max(padding, 1.58) : padding;
        let viewWidth = setup.width * framePadding;
        let viewHeight = setup.height * framePadding;

        if (aspect > targetAspect) {{
          viewWidth = viewHeight * aspect;
        }} else {{
          viewHeight = viewWidth / aspect;
        }}

        camera.left = -viewWidth / 2;
        camera.right = viewWidth / 2;
        camera.top = viewHeight / 2;
        camera.bottom = -viewHeight / 2;
        camera.near = 0.01;
        camera.far = maxDim * 12;
        camera.position.copy(setup.position);
        camera.up.copy(setup.up);
        camera.lookAt(center);
        camera.updateProjectionMatrix();
      }}

      function addBoundingBox(box) {{
        const helper = new THREE.Box3Helper(box, 0xa855ff);
        helper.material.depthTest = false;
        helper.material.transparent = true;
        helper.material.opacity = 0.85;
        scene.add(helper);
      }}

      function getDimensionSpec(faceName, box, size) {{
        const epsilon = Math.max(size.x, size.y, size.z) * 0.012;
        const specs = {{
          front: {{
            fixedAxis: "z",
            fixedValue: box.max.z + epsilon,
            uAxis: "x",
            vAxis: "y",
            uMin: box.min.x,
            uMax: box.max.x,
            vMin: box.min.y,
            vMax: box.max.y,
            horizontalLabel: "Width",
            horizontalValue: size.x,
            verticalLabel: "Height",
            verticalValue: size.y
          }},
          back: {{
            fixedAxis: "z",
            fixedValue: box.min.z - epsilon,
            uAxis: "x",
            vAxis: "y",
            uMin: box.min.x,
            uMax: box.max.x,
            vMin: box.min.y,
            vMax: box.max.y,
            horizontalLabel: "Width",
            horizontalValue: size.x,
            verticalLabel: "Height",
            verticalValue: size.y
          }},
          right: {{
            fixedAxis: "x",
            fixedValue: box.max.x + epsilon,
            uAxis: "z",
            vAxis: "y",
            uMin: box.min.z,
            uMax: box.max.z,
            vMin: box.min.y,
            vMax: box.max.y,
            horizontalLabel: "Depth",
            horizontalValue: size.z,
            verticalLabel: "Height",
            verticalValue: size.y
          }},
          left: {{
            fixedAxis: "x",
            fixedValue: box.min.x - epsilon,
            uAxis: "z",
            vAxis: "y",
            uMin: box.min.z,
            uMax: box.max.z,
            vMin: box.min.y,
            vMax: box.max.y,
            horizontalLabel: "Depth",
            horizontalValue: size.z,
            verticalLabel: "Height",
            verticalValue: size.y
          }},
          top: {{
            fixedAxis: "y",
            fixedValue: box.max.y + epsilon,
            uAxis: "x",
            vAxis: "z",
            uMin: box.min.x,
            uMax: box.max.x,
            vMin: box.min.z,
            vMax: box.max.z,
            horizontalLabel: "Width",
            horizontalValue: size.x,
            verticalLabel: "Length",
            verticalValue: size.z
          }},
          bottom: {{
            fixedAxis: "y",
            fixedValue: box.min.y - epsilon,
            uAxis: "x",
            vAxis: "z",
            uMin: box.min.x,
            uMax: box.max.x,
            vMin: box.min.z,
            vMax: box.max.z,
            horizontalLabel: "Width",
            horizontalValue: size.x,
            verticalLabel: "Length",
            verticalValue: size.z
          }}
        }};

        return specs[faceName] || specs.front;
      }}

      function pointFromSpec(spec, u, v) {{
        const point = new THREE.Vector3();
        point[spec.fixedAxis] = spec.fixedValue;
        point[spec.uAxis] = u;
        point[spec.vAxis] = v;
        return point;
      }}

      function addGuideLine(group, points, material) {{
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
        line.renderOrder = 2000;
        group.add(line);
        return line;
      }}

      function createDimensionLabel(text, scaleBase) {{
        const labelCanvas = document.createElement("canvas");
        labelCanvas.width = 768;
        labelCanvas.height = 192;
        const context = labelCanvas.getContext("2d");

        context.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
        context.fillStyle = "rgba(5, 6, 8, 0.82)";
        context.strokeStyle = "rgba(216, 251, 125, 0.96)";
        context.lineWidth = 8;
        context.beginPath();
        context.roundRect(28, 32, 712, 128, 24);
        context.fill();
        context.stroke();

        context.fillStyle = "#f6f7f2";
        context.font = "800 44px Arial, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(text, 384, 96);

        const texture = new THREE.CanvasTexture(labelCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;

        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({{
          map: texture,
          transparent: true,
          depthTest: false,
          depthWrite: false
        }}));
        sprite.scale.set(scaleBase * 0.42, scaleBase * 0.105, 1);
        sprite.renderOrder = 2002;
        return sprite;
      }}

      function addLabel(group, text, position, scaleBase) {{
        const label = createDimensionLabel(text, scaleBase);
        label.position.copy(position);
        group.add(label);
      }}

      function formatDimension(value) {{
        return `${value.toFixed(2)} units`;
      }}

      function addProjectedDimensions(faceName, box) {{
        const size = new THREE.Vector3();
        box.getSize(size);
        const spec = getDimensionSpec(faceName, box, size);
        const group = new THREE.Group();
        group.name = "orthographic-dimensions";

        const material = new THREE.LineBasicMaterial({{
          color: 0xd6fb7d,
          transparent: true,
          opacity: 0.98,
          depthTest: false,
          depthWrite: false
        }});

        const uSize = spec.uMax - spec.uMin;
        const vSize = spec.vMax - spec.vMin;
        const scaleBase = Math.max(uSize, vSize, 1);
        const offset = scaleBase * 0.11;
        const tick = scaleBase * 0.028;

        const bottomLeft = pointFromSpec(spec, spec.uMin, spec.vMin);
        const bottomRight = pointFromSpec(spec, spec.uMax, spec.vMin);
        const topRight = pointFromSpec(spec, spec.uMax, spec.vMax);
        const topLeft = pointFromSpec(spec, spec.uMin, spec.vMax);

        addGuideLine(group, [bottomLeft, bottomRight, topRight, topLeft, bottomLeft], material);

        const hStart = pointFromSpec(spec, spec.uMin, spec.vMin - offset);
        const hEnd = pointFromSpec(spec, spec.uMax, spec.vMin - offset);
        addGuideLine(group, [hStart, hEnd], material);
        addGuideLine(group, [
          pointFromSpec(spec, spec.uMin, spec.vMin - offset - tick),
          pointFromSpec(spec, spec.uMin, spec.vMin - offset + tick)
        ], material);
        addGuideLine(group, [
          pointFromSpec(spec, spec.uMax, spec.vMin - offset - tick),
          pointFromSpec(spec, spec.uMax, spec.vMin - offset + tick)
        ], material);
        addLabel(
          group,
          `${spec.horizontalLabel}: ${formatDimension(spec.horizontalValue)}`,
          pointFromSpec(spec, (spec.uMin + spec.uMax) / 2, spec.vMin - offset * 1.42),
          scaleBase
        );

        const vStart = pointFromSpec(spec, spec.uMin - offset, spec.vMin);
        const vEnd = pointFromSpec(spec, spec.uMin - offset, spec.vMax);
        addGuideLine(group, [vStart, vEnd], material);
        addGuideLine(group, [
          pointFromSpec(spec, spec.uMin - offset - tick, spec.vMin),
          pointFromSpec(spec, spec.uMin - offset + tick, spec.vMin)
        ], material);
        addGuideLine(group, [
          pointFromSpec(spec, spec.uMin - offset - tick, spec.vMax),
          pointFromSpec(spec, spec.uMin - offset + tick, spec.vMax)
        ], material);
        addLabel(
          group,
          `${spec.verticalLabel}: ${formatDimension(spec.verticalValue)}`,
          pointFromSpec(spec, spec.uMin - offset * 1.42, (spec.vMin + spec.vMax) / 2),
          scaleBase
        );

        const diagonalValue = Math.sqrt((uSize * uSize) + (vSize * vSize));
        addGuideLine(group, [bottomLeft, topRight], material);
        addLabel(
          group,
          `Diagonal: ${formatDimension(diagonalValue)}`,
          pointFromSpec(spec, (spec.uMin + spec.uMax) / 2, (spec.vMin + spec.vMax) / 2),
          scaleBase
        );

        scene.add(group);
      }}

      function pixelDistanceToUnits(start, end) {{
        const unitsPerPixelX = (camera.right - camera.left) / outputCanvas.width;
        const unitsPerPixelY = (camera.top - camera.bottom) / outputCanvas.height;
        const dx = (end.x - start.x) * unitsPerPixelX;
        const dy = (end.y - start.y) * unitsPerPixelY;
        return Math.sqrt((dx * dx) + (dy * dy));
      }}

      function pixelComponentsToUnits(start, end) {{
        const unitsPerPixelX = (camera.right - camera.left) / outputCanvas.width;
        const unitsPerPixelY = (camera.top - camera.bottom) / outputCanvas.height;
        return {{
          xUnits: Math.abs(end.x - start.x) * unitsPerPixelX,
          yUnits: Math.abs(end.y - start.y) * unitsPerPixelY
        }};
      }}

      function toSubscript(value) {{
        return String(value)
          .split("")
          .map((char) => SUBSCRIPT_DIGITS[char] || char)
          .join("");
      }}

      function dimensionLabel(prefix, index) {{
        return `${prefix}${toSubscript(index)}`;
      }}

      function getNearestRoofPitch(angleDegrees) {{
        if (!Array.isArray(ROOF_PITCH_TABLE) || ROOF_PITCH_TABLE.length === 0) return null;

        return ROOF_PITCH_TABLE.reduce((nearest, pitch) => {{
          const difference = Math.abs(angleDegrees - pitch.degrees);
          if (!nearest || difference < nearest.differenceDegrees) {{
            return {{
              ...pitch,
              differenceDegrees: difference
            }};
          }}
          return nearest;
        }}, null);
      }}

      function formatAlphaAngleLabel(measurementIndex, componentInfo) {{
        const baseLabel = `${dimensionLabel("\\u03b1", measurementIndex)}=${componentInfo.alphaDegrees.toFixed(2)}\\u00b0`;
        const nearestPitch = getNearestRoofPitch(componentInfo.alphaDegrees);
        if (!nearestPitch) return baseLabel;
        return `${baseLabel}=${nearestPitch.pitch}`;
      }}

      function perpendicularDistance(point, start, end) {{
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        if (dx === 0 && dy === 0) {{
          return Math.hypot(point.x - start.x, point.y - start.y);
        }}
        return Math.abs((dy * point.x) - (dx * point.y) + (end.x * start.y) - (end.y * start.x)) / Math.hypot(dx, dy);
      }}

      function simplifyRdp(points, epsilon) {{
        if (points.length <= 2) return points;

        let maxDistance = 0;
        let splitIndex = 0;
        const start = points[0];
        const end = points[points.length - 1];

        for (let index = 1; index < points.length - 1; index += 1) {{
          const distance = perpendicularDistance(points[index], start, end);
          if (distance > maxDistance) {{
            maxDistance = distance;
            splitIndex = index;
          }}
        }}

        if (maxDistance > epsilon) {{
          const left = simplifyRdp(points.slice(0, splitIndex + 1), epsilon);
          const right = simplifyRdp(points.slice(splitIndex), epsilon);
          return left.slice(0, -1).concat(right);
        }}

        return [start, end];
      }}

      function getAlphaBounds(imageData, width, height) {{
        const data = imageData.data;
        const alphaThreshold = 20;
        const bounds = {{
          minX: width,
          maxX: 0,
          minY: height,
          maxY: 0
        }};

        for (let y = 0; y < height; y += 1) {{
          for (let x = 0; x < width; x += 1) {{
            const alpha = data[((y * width + x) * 4) + 3];
            if (alpha > alphaThreshold) {{
              bounds.minX = Math.min(bounds.minX, x);
              bounds.maxX = Math.max(bounds.maxX, x);
              bounds.minY = Math.min(bounds.minY, y);
              bounds.maxY = Math.max(bounds.maxY, y);
            }}
          }}
        }}

        if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) return null;
        return bounds;
      }}

      function firstAlphaInColumn(data, width, minY, maxY, x) {{
        for (let y = minY; y <= maxY; y += 1) {{
          if (data[((y * width + x) * 4) + 3] > 20) return y;
        }}
        return null;
      }}

      function lastAlphaInColumn(data, width, minY, maxY, x) {{
        for (let y = maxY; y >= minY; y -= 1) {{
          if (data[((y * width + x) * 4) + 3] > 20) return y;
        }}
        return null;
      }}

      function firstAlphaInRow(data, width, minX, maxX, y) {{
        for (let x = minX; x <= maxX; x += 1) {{
          if (data[((y * width + x) * 4) + 3] > 20) return x;
        }}
        return null;
      }}

      function lastAlphaInRow(data, width, minX, maxX, y) {{
        for (let x = maxX; x >= minX; x -= 1) {{
          if (data[((y * width + x) * 4) + 3] > 20) return x;
        }}
        return null;
      }}

      function pushUnique(points, point) {{
        const last = points[points.length - 1];
        if (!last || last.x !== point.x || last.y !== point.y) points.push(point);
      }}

      function extractPerimeterEnvelopes(imageData, width, height) {{
        const bounds = getAlphaBounds(imageData, width, height);
        if (!bounds) return [];

        const top = [];
        const right = [];
        const bottom = [];
        const left = [];
        const data = imageData.data;
        const horizontalStep = Math.max(2, Math.round((bounds.maxX - bounds.minX) / 520));
        const verticalStep = Math.max(2, Math.round((bounds.maxY - bounds.minY) / 360));

        for (let x = bounds.minX; x <= bounds.maxX; x += horizontalStep) {{
          const y = firstAlphaInColumn(data, width, bounds.minY, bounds.maxY, x);
          if (y !== null) pushUnique(top, {{ x, y }});
        }}

        for (let y = bounds.minY; y <= bounds.maxY; y += verticalStep) {{
          const x = lastAlphaInRow(data, width, bounds.minX, bounds.maxX, y);
          if (x !== null) pushUnique(right, {{ x, y }});
        }}

        for (let x = bounds.maxX; x >= bounds.minX; x -= horizontalStep) {{
          const y = lastAlphaInColumn(data, width, bounds.minY, bounds.maxY, x);
          if (y !== null) pushUnique(bottom, {{ x, y }});
        }}

        for (let y = bounds.maxY; y >= bounds.minY; y -= verticalStep) {{
          const x = firstAlphaInRow(data, width, bounds.minX, bounds.maxX, y);
          if (x !== null) pushUnique(left, {{ x, y }});
        }}

        return [top, right, bottom, left].filter((side) => side.length >= 2);
      }}

      function getContourSegmentsFromAlpha(imageData) {{
        const width = imageData.width;
        const height = imageData.height;
        const sides = extractPerimeterEnvelopes(imageData, width, height);
        if (sides.length === 0) return [];

        const epsilon = Math.max(8, Math.min(width, height) * 0.02);
        const minPixelLength = Math.max(48, width * 0.03);
        const minUnitLength = 0.42;
        const segments = [];

        sides.forEach((side, sideIndex) => {{
          const simplified = simplifyRdp(side, epsilon);
          for (let index = 0; index < simplified.length - 1; index += 1) {{
            const start = simplified[index];
            const end = simplified[index + 1];
            const pixelLength = Math.hypot(end.x - start.x, end.y - start.y);
            const unitLength = pixelDistanceToUnits(start, end);

            if (pixelLength < minPixelLength || unitLength < minUnitLength) continue;

            segments.push({{ start, end, pixelLength, unitLength, sideIndex }});
          }}
        }});

        return removeDuplicateContourSegments(segments)
          .sort((a, b) => b.pixelLength - a.pixelLength)
          .slice(0, 26)
          .sort((a, b) => a.sideIndex - b.sideIndex || a.start.x - b.start.x || a.start.y - b.start.y);
      }}

      function angleDifference(a, b) {{
        const diff = Math.abs(a - b) % Math.PI;
        return Math.min(diff, Math.PI - diff);
      }}

      function segmentAngle(segment) {{
        return Math.atan2(segment.end.y - segment.start.y, segment.end.x - segment.start.x);
      }}

      function segmentMidpoint(segment) {{
        return {{
          x: (segment.start.x + segment.end.x) / 2,
          y: (segment.start.y + segment.end.y) / 2
        }};
      }}

      function projectedOverlapRatio(a, b) {{
        const horizontal = Math.abs(a.end.x - a.start.x) >= Math.abs(a.end.y - a.start.y);
        const a0 = horizontal ? Math.min(a.start.x, a.end.x) : Math.min(a.start.y, a.end.y);
        const a1 = horizontal ? Math.max(a.start.x, a.end.x) : Math.max(a.start.y, a.end.y);
        const b0 = horizontal ? Math.min(b.start.x, b.end.x) : Math.min(b.start.y, b.end.y);
        const b1 = horizontal ? Math.max(b.start.x, b.end.x) : Math.max(b.start.y, b.end.y);
        const overlap = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
        const shorter = Math.max(1, Math.min(a1 - a0, b1 - b0));
        return overlap / shorter;
      }}

      function isDuplicateContourSegment(candidate, existing) {{
        const angleClose = angleDifference(segmentAngle(candidate), segmentAngle(existing)) < 0.16;
        if (!angleClose) return false;

        const candidateMid = segmentMidpoint(candidate);
        const existingMid = segmentMidpoint(existing);
        const midpointDistance = Math.hypot(candidateMid.x - existingMid.x, candidateMid.y - existingMid.y);
        const closeMidpoints = midpointDistance < Math.max(32, outputCanvas.width * 0.026);
        const overlaps = projectedOverlapRatio(candidate, existing) > 0.68;
        return closeMidpoints && overlaps;
      }}

      function removeDuplicateContourSegments(segments) {{
        const ordered = [...segments].sort((a, b) => b.pixelLength - a.pixelLength);
        const filtered = [];

        ordered.forEach((segment) => {{
          if (!filtered.some((existing) => isDuplicateContourSegment(segment, existing))) {{
            filtered.push(segment);
          }}
        }});

        return filtered;
      }}

      function drawArrowHead(context, x, y, angle, size) {{
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x - Math.cos(angle - Math.PI / 6) * size, y - Math.sin(angle - Math.PI / 6) * size);
        context.lineTo(x - Math.cos(angle + Math.PI / 6) * size, y - Math.sin(angle + Math.PI / 6) * size);
        context.closePath();
        context.fill();
      }}

      function getSegmentNormalAwayFromCenter(start, end) {{
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        if (length === 0) return {{ x: 0, y: -1 }};

        const midpoint = {{
          x: (start.x + end.x) / 2,
          y: (start.y + end.y) / 2
        }};
        const center = {{
          x: outputCanvas.width / 2,
          y: outputCanvas.height / 2
        }};
        const normalA = {{ x: -dy / length, y: dx / length }};
        const normalB = {{ x: dy / length, y: -dx / length }};
        const away = {{ x: midpoint.x - center.x, y: midpoint.y - center.y }};
        const dotA = (normalA.x * away.x) + (normalA.y * away.y);
        const dotB = (normalB.x * away.x) + (normalB.y * away.y);
        return dotA > dotB ? normalA : normalB;
      }}

      function getDiagonalComponentInfo(start, end) {{
        const components = pixelComponentsToUnits(start, end);
        const pixelDx = Math.abs(end.x - start.x);
        const pixelDy = Math.abs(end.y - start.y);
        const angleDegrees = Math.atan2(pixelDy, pixelDx) * 180 / Math.PI;

        return {{
          ...components,
          angleDegrees,
          alphaDegrees: angleDegrees,
          betaDegrees: 90 - angleDegrees,
          hasComponents:
            angleDegrees >= DIAGONAL_COMPONENT_MIN_ANGLE_DEGREES &&
            angleDegrees <= DIAGONAL_COMPONENT_MAX_ANGLE_DEGREES &&
            components.xUnits >= DIAGONAL_COMPONENT_MIN_UNITS &&
            components.yUnits >= DIAGONAL_COMPONENT_MIN_UNITS
        }};
      }}

      function drawComponentLabel(context, text, x, y, rotation = 0) {{
        context.save();
        context.translate(x, y);
        context.rotate(rotation);
        context.textAlign = "center";
        context.textBaseline = "bottom";
        context.shadowColor = "rgba(0, 0, 0, 0.82)";
        context.shadowBlur = 5;
        context.shadowOffsetX = 0;
        context.shadowOffsetY = 2;
        context.fillText(text, 0, -3);
        context.restore();
      }}

      function shortestAngleDelta(from, to) {{
        return ((((to - from) + Math.PI) % (Math.PI * 2)) + (Math.PI * 2)) % (Math.PI * 2) - Math.PI;
      }}

      function drawAngleArc(context, vertex, firstPoint, secondPoint, radius, color, label) {{
        const startAngle = Math.atan2(firstPoint.y - vertex.y, firstPoint.x - vertex.x);
        const delta = shortestAngleDelta(startAngle, Math.atan2(secondPoint.y - vertex.y, secondPoint.x - vertex.x));
        const steps = 24;

        context.save();
        context.strokeStyle = color;
        context.fillStyle = color;
        context.lineWidth = Math.max(3, outputCanvas.width * 0.0025);
        context.lineCap = "round";
        context.beginPath();

        for (let index = 0; index <= steps; index += 1) {{
          const angle = startAngle + (delta * index / steps);
          const x = vertex.x + Math.cos(angle) * radius;
          const y = vertex.y + Math.sin(angle) * radius;
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }}

        context.stroke();

        const labelAngle = startAngle + (delta / 2);
        context.font = `900 ${Math.max(12, Math.round(outputCanvas.width * 0.011))}px Arial, sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.shadowColor = "rgba(0, 0, 0, 0.82)";
        context.shadowBlur = 5;
        context.shadowOffsetX = 0;
        context.shadowOffsetY = 2;
        context.fillText(
          label,
          vertex.x + Math.cos(labelAngle) * (radius + 24),
          vertex.y + Math.sin(labelAngle) * (radius + 24)
        );
        context.restore();
      }}

      function normalizedVector(from, to) {{
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy) || 1;
        return {{ x: dx / length, y: dy / length }};
      }}

      function drawRightAngleMarker(context, corner, horizontalPoint, verticalPoint) {{
        const size = Math.max(16, outputCanvas.width * 0.014);
        const hVector = normalizedVector(corner, horizontalPoint);
        const vVector = normalizedVector(corner, verticalPoint);
        const p1 = {{ x: corner.x + hVector.x * size, y: corner.y + hVector.y * size }};
        const p2 = {{ x: p1.x + vVector.x * size, y: p1.y + vVector.y * size }};
        const p3 = {{ x: corner.x + vVector.x * size, y: corner.y + vVector.y * size }};

        context.save();
        context.strokeStyle = "#d200ff";
        context.lineWidth = Math.max(3, outputCanvas.width * 0.0023);
        context.lineCap = "square";
        context.lineJoin = "miter";
        context.beginPath();
        context.moveTo(p1.x, p1.y);
        context.lineTo(p2.x, p2.y);
        context.lineTo(p3.x, p3.y);
        context.stroke();
        context.restore();
      }}

      function drawAngleOverlay(context, overlay) {{
        const {{ startPoint, endPoint, cornerPoint, arcRadius, componentInfo, measurementIndex }} = overlay;
        drawRightAngleMarker(context, cornerPoint, startPoint, endPoint);
        drawAngleArc(
          context,
          startPoint,
          cornerPoint,
          endPoint,
          arcRadius,
          "#ff2424",
          formatAlphaAngleLabel(measurementIndex, componentInfo)
        );

        if (SHOW_BETA_ANGLE_LABELS) {{
          drawAngleArc(
            context,
            endPoint,
            startPoint,
            cornerPoint,
            arcRadius,
            "#ffff00",
            `${dimensionLabel("\\u03b2", measurementIndex)}=${componentInfo.betaDegrees.toFixed(2)}\\u00b0`
          );
        }}
      }}

      function drawDiagonalComponents(context, start, end, sx, sy, ex, ey, measurementIndex, angleOverlayQueue) {{
        const componentInfo = getDiagonalComponentInfo(start, end);
        if (!componentInfo.hasComponents) return componentInfo;

        const cornerX = ex;
        const cornerY = sy;
        const horizontalAngle = ex >= sx ? 0 : Math.PI;
        const verticalAngle = ey >= sy ? Math.PI / 2 : -Math.PI / 2;
        const arrowSize = Math.max(5, outputCanvas.width * 0.0048);

        context.save();
        context.strokeStyle = "#7cff72";
        context.fillStyle = "#7cff72";
        context.lineWidth = Math.max(1.2, outputCanvas.width * 0.0012);
        context.lineCap = "round";
        context.lineJoin = "round";
        context.setLineDash([7, 6]);

        context.beginPath();
        context.moveTo(sx, sy);
        context.lineTo(cornerX, cornerY);
        context.lineTo(ex, ey);
        context.stroke();

        context.setLineDash([]);
        drawArrowHead(context, cornerX, cornerY, horizontalAngle, arrowSize);
        drawArrowHead(context, sx, sy, horizontalAngle + Math.PI, arrowSize);
        drawArrowHead(context, ex, ey, verticalAngle, arrowSize);
        drawArrowHead(context, cornerX, cornerY, verticalAngle + Math.PI, arrowSize);

        if (SHOW_DIMENSION_VALUE_LABELS) {{
          context.font = `800 ${Math.max(9, Math.round(outputCanvas.width * 0.0085))}px Arial, sans-serif`;
          drawComponentLabel(
            context,
            `${dimensionLabel("X", measurementIndex)}=${componentInfo.xUnits.toFixed(2)}`,
            (sx + cornerX) / 2,
            cornerY - 4,
            0
          );
          drawComponentLabel(
            context,
            `${dimensionLabel("Y", measurementIndex)}=${componentInfo.yUnits.toFixed(2)}`,
            cornerX + 8,
            (cornerY + ey) / 2,
            -Math.PI / 2
          );
        }}

        const startPoint = {{ x: sx, y: sy }};
        const endPoint = {{ x: ex, y: ey }};
        const cornerPoint = {{ x: cornerX, y: cornerY }};
        const arcRadius = Math.max(24, outputCanvas.width * 0.022);
        angleOverlayQueue.push({{
          startPoint,
          endPoint,
          cornerPoint,
          arcRadius,
          componentInfo,
          measurementIndex
        }});
        context.restore();

        return componentInfo;
      }}

      function drawSegmentDimension(context, segment, index, angleOverlayQueue) {{
        const {{ start, end, unitLength }} = segment;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        if (length === 0) return;

        const normal = getSegmentNormalAwayFromCenter(start, end);
        const offset = 8 + ((index % 2) * 5);
        const sx = start.x + normal.x * offset;
        const sy = start.y + normal.y * offset;
        const ex = end.x + normal.x * offset;
        const ey = end.y + normal.y * offset;
        const angle = Math.atan2(ey - sy, ex - sx);
        const arrowSize = Math.max(6, outputCanvas.width * 0.0055);
        const measurementIndex = index + 1;

        context.save();
        drawDiagonalComponents(context, start, end, sx, sy, ex, ey, measurementIndex, angleOverlayQueue);
        context.strokeStyle = "#00ff2a";
        context.fillStyle = "#00ff2a";
        context.lineWidth = Math.max(1.5, outputCanvas.width * 0.0016);
        context.lineCap = "round";
        context.lineJoin = "round";

        context.beginPath();
        context.moveTo(sx, sy);
        context.lineTo(ex, ey);
        context.stroke();
        drawArrowHead(context, ex, ey, angle, arrowSize);
        drawArrowHead(context, sx, sy, angle + Math.PI, arrowSize);

        const midX = (sx + ex) / 2;
        const midY = (sy + ey) / 2;
        const label = `${dimensionLabel("C", measurementIndex)}=${unitLength.toFixed(2)}`;
        if (SHOW_DIMENSION_VALUE_LABELS) {{
          context.font = `800 ${Math.max(10, Math.round(outputCanvas.width * 0.01))}px Arial, sans-serif`;
          context.textAlign = "center";
          context.textBaseline = "bottom";
          context.shadowColor = "rgba(0, 0, 0, 0.82)";
          context.shadowBlur = 6;
          context.shadowOffsetX = 0;
          context.shadowOffsetY = 2;

          context.translate(midX + (normal.x * 5), midY + (normal.y * 5));
          let labelAngle = angle;
          if (labelAngle > Math.PI / 2 || labelAngle < -Math.PI / 2) labelAngle += Math.PI;
          context.rotate(labelAngle);
          context.fillText(label, 0, 0);
        }}
        context.restore();
      }}

      function drawAutomaticContourDimensions(context) {{
        const imageData = context.getImageData(0, 0, outputCanvas.width, outputCanvas.height);
        const segments = getContourSegmentsFromAlpha(imageData);
        const angleOverlayQueue = [];
        segments.forEach((segment, index) => drawSegmentDimension(context, segment, index, angleOverlayQueue));
        angleOverlayQueue.forEach((overlay) => drawAngleOverlay(context, overlay));
        window.__dimensionSegments = segments.map((segment, index) => {{
          const measurementIndex = index + 1;
          const componentInfo = getDiagonalComponentInfo(segment.start, segment.end);
          const nearestAlphaPitch = getNearestRoofPitch(componentInfo.alphaDegrees);
          return {{
            id: dimensionLabel("C", measurementIndex),
            label: dimensionLabel("C", measurementIndex),
            xLabel: dimensionLabel("X", measurementIndex),
            yLabel: dimensionLabel("Y", measurementIndex),
            alphaLabel: dimensionLabel("\\u03b1", measurementIndex),
            betaLabel: dimensionLabel("\\u03b2", measurementIndex),
            alphaPitch: nearestAlphaPitch ? nearestAlphaPitch.pitch : null,
            alphaPitchDegrees: nearestAlphaPitch ? Number(nearestAlphaPitch.degrees.toFixed(2)) : null,
            alphaPitchCategory: nearestAlphaPitch ? nearestAlphaPitch.category : null,
            alphaPitchDeltaDegrees: nearestAlphaPitch ? Number(nearestAlphaPitch.differenceDegrees.toFixed(4)) : null,
            start: segment.start,
            end: segment.end,
            lengthUnits: Number(segment.unitLength.toFixed(4)),
            xUnits: Number(componentInfo.xUnits.toFixed(4)),
            yUnits: Number(componentInfo.yUnits.toFixed(4)),
            angleDegrees: Number(componentInfo.angleDegrees.toFixed(2)),
            alphaDegrees: Number(componentInfo.alphaDegrees.toFixed(2)),
            betaDegrees: Number(componentInfo.betaDegrees.toFixed(2)),
            hasComponents: componentInfo.hasComponents
          }};
        }});
      }}

      function renderScene() {{
        renderer.render(scene, camera);
        outputContext.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        outputContext.drawImage(canvas, 0, 0);
        if (showDimensions) drawAutomaticContourDimensions(outputContext);
        status.remove();
        document.body.dataset.renderReady = "1";
      }}

      if (!modelUrl) {{
        status.textContent = "Missing model parameter";
        throw new Error("Missing model parameter");
      }}

      new GLTFLoader().load(
        modelUrl,
        (gltf) => {{
          const model = gltf.scene;
          model.traverse((child) => {{
            if (child.isMesh) {{
              child.frustumCulled = false;
              if (child.material) {{
                child.material.side = THREE.FrontSide;
              }}
            }}
          }});

          normalizeModelToAppScale(model);
          scene.add(model);

          const box = new THREE.Box3().setFromObject(model);
          frameOrthographicCamera(face, box);
          if (showBox) addBoundingBox(box);

          requestAnimationFrame(() => {{
            renderScene();
            setTimeout(renderScene, 250);
          }});
        }},
        undefined,
        (error) => {{
          console.error(error);
          status.textContent = "Could not load GLB";
        }}
      );
    </script>
  </body>
</html>
"""


class QuietHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return


def resolve_model_path(model_arg: str) -> Path:
    model_path = Path(model_arg)
    if not model_path.is_absolute():
        model_path = PROJECT_ROOT / model_path

    model_path = model_path.resolve()
    if not model_path.exists():
        raise SystemExit(f"GLB model not found: {model_path}")
    if model_path.suffix.lower() != ".glb":
        raise SystemExit(f"Input must be a .glb file: {model_path}")

    return model_path


def find_browser(explicit_browser: str | None) -> Path:
    candidates: list[str | Path] = []

    if explicit_browser:
        candidates.append(explicit_browser)

    env_browser = os.environ.get("BROWSER_PATH")
    if env_browser:
        candidates.append(env_browser)

    for command in ("msedge", "chrome", "chromium", "chromium-browser", "google-chrome"):
        found = shutil.which(command)
        if found:
            candidates.append(found)

    program_files = [
        os.environ.get("PROGRAMFILES"),
        os.environ.get("PROGRAMFILES(X86)"),
        os.environ.get("LOCALAPPDATA"),
    ]
    for base in program_files:
        if not base:
            continue
        candidates.extend(
            [
                Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
                Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe",
            ]
        )

    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return path.resolve()

    raise SystemExit(
        "No Chromium-based browser was found. Install Chrome/Edge or pass "
        "--browser C:\\\\Path\\\\To\\\\chrome.exe, or set BROWSER_PATH."
    )


def load_roof_pitch_table() -> list[dict[str, object]]:
    table_path = SCRIPT_DIR / "roof_pitch_to_degrees_conversion_table.csv"
    if not table_path.exists():
        return []

    table: list[dict[str, object]] = []
    with table_path.open(newline="", encoding="utf-8") as file:
        reader = csv.DictReader(file)
        for row in reader:
            pitch = (row.get("Pitch") or "").strip()
            degrees_text = (row.get("Degrees") or "").strip()
            if not pitch or not degrees_text:
                continue

            try:
                degrees = float(degrees_text)
            except ValueError:
                continue

            table.append(
                {
                    "pitch": pitch,
                    "riseRun": (row.get("Rise_Run") or "").strip(),
                    "degrees": degrees,
                    "category": (row.get("Category") or "").strip(),
                }
            )

    return table


def write_renderer_html() -> Path:
    html_path = PROJECT_ROOT / TEMP_RENDERER_NAME
    html = HTML_TEMPLATE.replace("{{", "{").replace("}}", "}")
    html = html.replace("__ROOF_PITCH_TABLE_JSON__", json.dumps(load_roof_pitch_table()))
    html_path.write_text(html, encoding="utf-8")
    return html_path


def start_server() -> tuple[http.server.ThreadingHTTPServer, str]:
    handler = functools.partial(QuietHTTPRequestHandler, directory=str(PROJECT_ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, f"http://{host}:{port}"


def get_available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class DevToolsClient:
    def __init__(self, websocket_url: str):
        try:
            import websocket
        except ImportError as exc:
            raise SystemExit(
                "Missing Python dependency: websocket-client. Run: "
                "python -m pip install -r requirements.txt"
            ) from exc

        self.ws = websocket.create_connection(websocket_url, timeout=10)
        self.next_id = 1

    def close(self) -> None:
        self.ws.close()

    def call(self, method: str, params: dict | None = None) -> dict:
        message_id = self.next_id
        self.next_id += 1
        self.ws.send(json.dumps({
            "id": message_id,
            "method": method,
            "params": params or {},
        }))

        while True:
            message = json.loads(self.ws.recv())
            if message.get("id") == message_id:
                if "error" in message:
                    raise RuntimeError(f"Chrome DevTools error: {message['error']}")
                return message.get("result", {})


def wait_for_devtools_url(port: int, timeout_seconds: float = 10) -> str:
    deadline = time.monotonic() + timeout_seconds
    targets_url = f"http://127.0.0.1:{port}/json"

    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(targets_url, timeout=1) as response:
                payload = json.loads(response.read().decode("utf-8"))
                for target in payload:
                    if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                        return target["webSocketDebuggerUrl"]
        except Exception:
            time.sleep(0.15)

    raise SystemExit("Chrome DevTools page target did not become available in time.")


def wait_for_render_ready(client: DevToolsClient, wait_ms: int) -> None:
    deadline = time.monotonic() + (wait_ms / 1000)

    while time.monotonic() < deadline:
        result = client.call(
            "Runtime.evaluate",
            {
                "expression": "document.body.dataset.renderReady === '1'",
                "returnByValue": True,
            },
        )
        value = result.get("result", {}).get("value")
        if value is True:
            return

        time.sleep(0.25)

    status_result = client.call(
        "Runtime.evaluate",
        {
            "expression": "document.querySelector('#status')?.textContent || document.body.dataset.renderReady || 'not ready'",
            "returnByValue": True,
        },
    )
    status = status_result.get("result", {}).get("value", "not ready")
    raise SystemExit(f"Timed out waiting for Three.js renderReady. Page status: {status}")


def get_dimension_segments(client: DevToolsClient) -> list[dict]:
    result = client.call(
        "Runtime.evaluate",
        {
            "expression": "window.__dimensionSegments || []",
            "returnByValue": True,
        },
    )
    value = result.get("result", {}).get("value", [])
    return value if isinstance(value, list) else []



def get_output_canvas_metrics(client: DevToolsClient) -> dict[str, int]:
    """Return the output canvas dimensions and count of visible pixels."""
    result = client.call(
        "Runtime.evaluate",
        {
            "expression": """
                (() => {
                  const canvas = document.querySelector('#output');
                  if (!canvas) return { width: 0, height: 0, nontransparent_pixels: 0 };
                  const context = canvas.getContext('2d');
                  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                  let nontransparent = 0;
                  for (let index = 3; index < pixels.length; index += 4) {
                    if (pixels[index] > 0) nontransparent += 1;
                  }
                  return {
                    width: canvas.width,
                    height: canvas.height,
                    nontransparent_pixels: nontransparent,
                  };
                })()
            """,
            "returnByValue": True,
        },
    )
    value = result.get("result", {}).get("value", {})
    return value if isinstance(value, dict) else {}


def verify_png_output(
    output_file: Path,
    expected_width: int,
    expected_height: int,
    min_file_size: int,
    canvas_metrics: dict[str, int],
) -> dict[str, int]:
    """Validate a freshly captured PNG before it becomes the published output."""
    if not output_file.is_file():
        raise ValueError("PNG file was not created")

    file_size = output_file.stat().st_size
    if file_size < min_file_size:
        raise ValueError(
            f"PNG is too small ({file_size} bytes; minimum is {min_file_size})"
        )

    header = output_file.read_bytes()[:24]
    png_signature = b"\x89PNG\r\n\x1a\n"
    if len(header) < 24 or header[:8] != png_signature or header[12:16] != b"IHDR":
        raise ValueError("captured file is not a valid PNG with an IHDR header")

    actual_width, actual_height = struct.unpack(">II", header[16:24])
    if (actual_width, actual_height) != (expected_width, expected_height):
        raise ValueError(
            "PNG dimensions do not match the requested render size "
            f"({actual_width}x{actual_height}, expected {expected_width}x{expected_height})"
        )

    if (
        canvas_metrics.get("width") != expected_width
        or canvas_metrics.get("height") != expected_height
    ):
        raise ValueError("output canvas dimensions do not match the requested render size")

    nontransparent_pixels = int(canvas_metrics.get("nontransparent_pixels", 0))
    if nontransparent_pixels <= 0:
        raise ValueError("output canvas contains no visible model pixels")

    return {
        "file_size_bytes": file_size,
        "width": actual_width,
        "height": actual_height,
        "nontransparent_pixels": nontransparent_pixels,
    }


def run_browser_screenshot(
    browser: Path,
    url: str,
    output_file: Path,
    width: int,
    height: int,
    wait_ms: int,
    min_file_size: int,
    retries: int,
    retry_wait_step_ms: int,
) -> dict[str, object]:
    attempts = retries + 1
    last_error = "unknown rendering failure"

    for attempt in range(attempts):
        current_wait_ms = wait_ms + (retry_wait_step_ms * attempt)
        debug_port = get_available_port()
        profile_dir = Path(tempfile.mkdtemp(prefix="glb-face-browser-"))
        temporary_output = output_file.with_name(
            f".{output_file.name}.attempt-{attempt + 1}.png"
        )
        temporary_output.unlink(missing_ok=True)
        command = [
            str(browser),
            "--headless=new",
            "--disable-gpu",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
            "--use-angle=swiftshader",
            "--use-gl=angle",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-background-networking",
            "--disable-extensions",
            "--hide-scrollbars",
            "--no-first-run",
            "--run-all-compositor-stages-before-draw",
            f"--user-data-dir={profile_dir}",
            f"--window-size={width},{height}",
            f"--remote-debugging-port={debug_port}",
            "--remote-debugging-address=127.0.0.1",
            "--remote-allow-origins=*",
            "about:blank",
        ]

        process = subprocess.Popen(command, cwd=PROJECT_ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        client = None

        try:
            websocket_url = wait_for_devtools_url(debug_port)
            client = DevToolsClient(websocket_url)
            client.call("Page.enable")
            client.call("Runtime.enable")
            client.call(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": width,
                    "height": height,
                    "deviceScaleFactor": 1,
                    "mobile": False,
                },
            )
            client.call("Page.navigate", {"url": url})
            wait_for_render_ready(client, current_wait_ms)
            canvas_capture = client.call(
                "Runtime.evaluate",
                {
                    "expression": "document.querySelector('#output').toDataURL('image/png')",
                    "returnByValue": True,
                },
            )
            data_url = canvas_capture.get("result", {}).get("value", "")
            if not data_url.startswith("data:image/png;base64,"):
                raise SystemExit("Canvas did not return a PNG data URL.")
            temporary_output.write_bytes(base64.b64decode(data_url.split(",", 1)[1]))
            dimension_segments = get_dimension_segments(client)
            canvas_metrics = get_output_canvas_metrics(client)
            verification = verify_png_output(
                temporary_output,
                width,
                height,
                min_file_size,
                canvas_metrics,
            )
            temporary_output.replace(output_file)
            verification["attempt"] = attempt + 1
            return {
                "dimension_segments": dimension_segments,
                "verification": verification,
            }
        except (OSError, RuntimeError, SystemExit, ValueError) as error:
            last_error = str(error)
            temporary_output.unlink(missing_ok=True)
            if attempt < retries:
                print(
                    f"  Attempt {attempt + 1}/{attempts} failed: {last_error}. "
                    f"Retrying with {current_wait_ms + retry_wait_step_ms} ms..."
                )
        finally:
            if client:
                client.close()
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
            shutil.rmtree(profile_dir, ignore_errors=True)

    raise SystemExit(
        f"{output_file.name} could not be verified after {attempts} attempt(s). "
        f"Last error: {last_error}"
    )


def to_url_path(path: Path) -> str:
    relative = path.resolve().relative_to(PROJECT_ROOT)
    return relative.as_posix()


def build_face_url(
    base_url: str,
    model_path: Path,
    face: str,
    padding: float,
    target_width: float,
    show_box: bool,
    dimensions: bool,
) -> str:
    from urllib.parse import urlencode

    query = urlencode(
        {
            "model": to_url_path(model_path),
            "face": face,
            "padding": f"{padding:.4f}",
            "targetWidth": f"{target_width:.4f}",
            "showBox": "1" if show_box else "0",
            "dimensions": "1" if dimensions else "0",
        }
    )
    return f"{base_url}/{TEMP_RENDERER_NAME}?{query}"


def create_run_output_dir(base_output_dir: str, model_path: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_model_name = "".join(
        character if character.isalnum() or character in ("-", "_") else "_"
        for character in model_path.stem
    )
    base_dir = (PROJECT_ROOT / base_output_dir).resolve()
    run_dir = base_dir / f"{timestamp}_{safe_model_name}"
    counter = 1

    while run_dir.exists():
        run_dir = base_dir / f"{timestamp}_{safe_model_name}_{counter:02d}"
        counter += 1

    run_dir.mkdir(parents=True, exist_ok=False)
    return run_dir


def resolve_output_dir(args: argparse.Namespace, model_path: Path) -> Path:
    exact_output_dir = getattr(args, "output_run_dir", None)
    if exact_output_dir:
        output_dir = Path(exact_output_dir).resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        return output_dir

    return create_run_output_dir(args.output_dir, model_path)


def render_faces(args: argparse.Namespace) -> dict[str, object]:
    model_path = resolve_model_path(args.model)
    browser = find_browser(args.browser)
    output_dir = resolve_output_dir(args, model_path)

    html_path = write_renderer_html()
    server, base_url = start_server()
    generated: list[dict[str, object]] = []

    try:
        for face in args.faces:
            output_file = output_dir / f"{model_path.stem}_{face}.png"
            url = build_face_url(
                base_url,
                model_path,
                face,
                args.padding,
                args.target_width,
                args.show_box,
                args.dimensions,
            )
            print(f"Rendering {face}: {output_file}")
            try:
                screenshot = run_browser_screenshot(
                    browser,
                    url,
                    output_file,
                    args.width,
                    args.height,
                    args.wait_ms,
                    args.min_file_size,
                    args.retries,
                    args.retry_wait_step_ms,
                )
                generated.append({
                    "face": face,
                    "file": str(output_file),
                    "status": "verified",
                    "dimension_segments": screenshot["dimension_segments"],
                    "verification": screenshot["verification"],
                })
            except (SystemExit, Exception) as error:
                generated.append({
                    "face": face,
                    "file": str(output_file),
                    "status": "failed",
                    "error": str(error),
                })
                print(f"  Failed {face}: {error}", file=sys.stderr)
    finally:
        server.shutdown()
        server.server_close()
        if not args.keep_html:
            html_path.unlink(missing_ok=True)

    verified_faces = [item for item in generated if item["status"] == "verified"]
    failed_faces = [item for item in generated if item["status"] == "failed"]
    manifest = {
        "model": str(model_path),
        "browser": str(browser),
        "projection": "orthographic",
        "faces": generated,
        "verified_faces": len(verified_faces),
        "failed_faces": len(failed_faces),
        "status": (
            "success" if not failed_faces
            else "partial" if verified_faces
            else "failed"
        ),
        "width": args.width,
        "height": args.height,
        "padding": args.padding,
        "target_width": args.target_width,
        "show_box": args.show_box,
        "dimensions": args.dimensions,
        "requested_faces": args.faces,
        "min_file_size": args.min_file_size,
        "retries": args.retries,
        "retry_wait_step_ms": args.retry_wait_step_ms,
    }
    manifest_path = output_dir / f"{model_path.stem}_six_faces_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print("")
    print(f"Done. Images saved in: {output_dir}")
    print(f"Manifest: {manifest_path}")
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Create six orthographic PNG renders from a GLB model using Python 3 and Chrome/Edge."
    )
    parser.add_argument(
        "model",
        help="Path to the .glb file to render.",
    )
    parser.add_argument(
        "--output-dir",
        default="outputs",
        help="Base folder where a dated output subfolder will be created.",
    )
    parser.add_argument(
        "--faces",
        nargs="+",
        default=list(FACES),
        choices=FACES,
        help="Faces to render. Use this to test one face before rendering all six.",
    )
    parser.add_argument("--width", type=int, default=1600, help="Screenshot width in pixels.")
    parser.add_argument("--height", type=int, default=1000, help="Screenshot height in pixels.")
    parser.add_argument(
        "--padding",
        type=float,
        default=1.08,
        help="Framing padding around the model. Higher means more empty border.",
    )
    parser.add_argument(
        "--target-width",
        type=float,
        default=10.0,
        help="Uniformly normalize the model to this max X/Z width. Use 0 to preserve original scale.",
    )
    parser.add_argument(
        "--wait-ms",
        type=int,
        default=30000,
        help="Virtual time budget for the headless browser to load and render the GLB.",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=2,
        help="Number of extra attempts if the screenshot still looks like a loading/blank image.",
    )
    parser.add_argument(
        "--retry-wait-step-ms",
        type=int,
        default=20000,
        help="Additional wait time added on each retry.",
    )
    parser.add_argument(
        "--min-file-size",
        type=int,
        default=10000,
        help="Minimum PNG size in bytes accepted as a rendered image.",
    )
    parser.add_argument(
        "--show-box",
        action="store_true",
        help="Overlay the model bounding box in the rendered images.",
    )
    parser.add_argument(
        "--no-dimensions",
        action="store_false",
        dest="dimensions",
        help="Disable automatic dimension guides over the rendered images.",
    )
    parser.set_defaults(dimensions=True)
    parser.add_argument(
        "--browser",
        help="Explicit path to Chrome or Edge. You can also set BROWSER_PATH.",
    )
    parser.add_argument(
        "--keep-html",
        action="store_true",
        help="Keep the temporary Three.js renderer HTML file for debugging.",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    render_faces(args)


if __name__ == "__main__":
    main()
