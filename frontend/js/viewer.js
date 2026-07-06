import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const canvas = document.querySelector('#viewerCanvas');
const loadingPanel = document.querySelector('#loadingPanel');
const projectNameLabel = document.querySelector('#viewerProjectName');
const projectTitleInput = document.querySelector('#viewerProjectTitleInput');
const projectTitleSave = document.querySelector('#viewerProjectTitleSave');
const projectCommentsInput = document.querySelector('#projectCommentsInput');
const projectCommentsSave = document.querySelector('#projectCommentsSave');
const projectCommentsStatus = document.querySelector('#projectCommentsStatus');
const subtitle = document.querySelector('#viewerSubtitle');
const viewerModelProvider = document.querySelector('#viewerModelProvider');
const downloadLink = document.querySelector('#downloadLink');
const orthophotosLink = document.querySelector('#orthophotosLink');
const refreshInsightsButton = document.querySelector('#refreshInsightsButton');
const refreshHumanScaleButton = document.querySelector('#refreshHumanScaleButton');
const insightsStatus = document.querySelector('#insightsStatus');
const viewerMetrics = document.querySelector('#viewerMetrics');
const viewerPhotoCount = document.querySelector('#viewerPhotoCount');
const viewerOrthophotoGrid = document.querySelector('#viewerOrthophotoGrid');
const viewerComparisonTitle = document.querySelector('#viewerComparisonTitle');
const viewerComparisonCount = document.querySelector('#viewerComparisonCount');
const viewerComparisonGrid = document.querySelector('#viewerComparisonGrid');
const scaleModal = document.querySelector('#scaleModal');
const scaleCanvas = document.querySelector('#scaleCanvas');
const scaleModalTitle = document.querySelector('#scaleModalTitle');
const scaleModalCloseButton = document.querySelector('#scaleModalCloseButton');
const scaleForm = document.querySelector('#scaleForm');
const scaleMetersInput = document.querySelector('#scaleMetersInput');
const scalePixelDistance = document.querySelector('#scalePixelDistance');
const scaleResetButton = document.querySelector('#scaleResetButton');
const scaleSaveButton = document.querySelector('#scaleSaveButton');

const params = new URLSearchParams(window.location.search);
const modelUrl = params.get('model');
const projectName = params.get('project') || 'Project';

if (projectNameLabel) projectNameLabel.textContent = projectName;
downloadLink.href = modelUrl || '#';

let insightsPollTimer = null;
let currentInsightsData = null;
let scaleState = {
  file: null,
  image: null,
  points: [],
  previewPoint: null,
};

function setOrthophotosLink(hasOrthophotos) {
  if (!orthophotosLink) return;
  const query = new URLSearchParams({ project: projectName });
  if (!hasOrthophotos) query.set('start', '1');
  orthophotosLink.textContent = hasOrthophotos ? 'Watch Orthophotos' : 'Create Orthophotos';
  orthophotosLink.href = `/orthophotos.html?${query.toString()}`;
}

function formatNumber(value, decimals = 3) {
  if (value === null || value === undefined) return '-';
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(decimals) : '-';
}

function providerLabel(modelProvider) {
  if (modelProvider === 'hyper3d') return 'Hyper3D';
  if (modelProvider === 'tencent') return 'Tencent';
  return 'Unknown';
}

function metricCard(label, value) {
  const card = document.createElement('div');
  card.className = 'viewer-metric';

  const strong = document.createElement('strong');
  strong.textContent = value;

  const span = document.createElement('span');
  span.textContent = label;

  card.appendChild(strong);
  card.appendChild(span);
  return card;
}

function metricSection(titleText, metrics) {
  const section = document.createElement('section');
  section.className = 'viewer-metric-section';

  const heading = document.createElement('h3');
  heading.textContent = titleText;

  const grid = document.createElement('div');
  grid.className = 'viewer-metric-grid';
  for (const metric of metrics) {
    grid.appendChild(metricCard(metric.label, metric.value));
  }

  section.appendChild(heading);
  section.appendChild(grid);
  return section;
}

function faceLabel(fileName) {
  const normalized = fileName.replace(/\.[^.]+$/i, '');
  const comparisonMatch = normalized.match(/(.+)_comparison$/i);
  if (comparisonMatch) return comparisonMatch[1].replace(/_/g, ' ');
  const editedMatch = normalized.match(/(.+)_edited$/i);
  if (editedMatch) return editedMatch[1].replace(/_/g, ' ');
  const match = fileName.match(/_(front|back|right|left|top|bottom)\.png$/i);
  return match ? match[1] : normalized.replace(/_/g, ' ');
}

function calculateMetricTopArea(topArea, glbDimensions, buildingDimensions) {
  if (!topArea || !glbDimensions || !buildingDimensions) return null;

  const areaUnits = Number(topArea.area_units_squared);
  const projectedUnits = Number(topArea.projected_area_units_squared);
  const glbWidthUnits = Number(glbDimensions.width_units);
  const glbLengthUnits = Number(glbDimensions.length_units);
  const frontWidthMeters = Number(buildingDimensions.front_width_m);
  const buildingLengthMeters = Number(buildingDimensions.building_length_m);

  if (
    !Number.isFinite(areaUnits)
    || !Number.isFinite(projectedUnits)
    || !Number.isFinite(glbWidthUnits)
    || !Number.isFinite(glbLengthUnits)
    || !Number.isFinite(frontWidthMeters)
    || !Number.isFinite(buildingLengthMeters)
    || glbWidthUnits <= 0
    || glbLengthUnits <= 0
  ) {
    return null;
  }

  const modelTopRectangleUnits2 = glbWidthUnits * glbLengthUnits;
  const estimatedTopRectangleM2 = frontWidthMeters * buildingLengthMeters;
  const squareMetersPerModelUnit2 = estimatedTopRectangleM2 / modelTopRectangleUnits2;

  return {
    areaM2: areaUnits * squareMetersPerModelUnit2,
    projectedAreaM2: projectedUnits * squareMetersPerModelUnit2,
    squareMetersPerModelUnit2,
  };
}

function renderPhotoCard(file, titleText, selectable = true) {
  const card = document.createElement('button');
  card.className = 'viewer-photo-card';
  card.type = 'button';
  card.disabled = !selectable;
  card.title = selectable ? `Set reference scale using ${titleText}` : titleText;

  const heading = document.createElement('h3');
  heading.textContent = titleText;

  const image = document.createElement('img');
  image.src = `${file.url}?v=${Date.now()}`;
  image.alt = `${titleText} image`;
  image.loading = 'lazy';

  card.appendChild(heading);
  card.appendChild(image);
  if (selectable) {
    card.addEventListener('click', () => {
      openScaleModal(file).catch((error) => {
        insightsStatus.textContent = `Could not open reference scale editor: ${error.message}`;
      });
    });
  }
  return card;
}

function renderInsights(data) {
  currentInsightsData = data;
  const files = data.files || [];
  const comparisonFiles = data.comparisonFiles || [];
  const referenceScale = data.referenceScale || data.humanScale || {};
  const topArea = data.topArea || {};
  const glbModelDimensions = data.glbModelDimensions || {};
  const referenceScaleDimensions = referenceScale.metadata && referenceScale.metadata.building_dimensions;

  setOrthophotosLink(Boolean(data.exists));
  const comparisonSource = data.comparisonSource || 'comparison';
  const isEditedFallback = comparisonSource === 'edited';
  if (refreshHumanScaleButton) {
    refreshHumanScaleButton.disabled = !files.length;
    refreshHumanScaleButton.textContent = referenceScale.exists ? 'Update Reference Scale' : 'Set Reference Scale';
  }
  viewerPhotoCount.textContent = `${files.length} / ${data.expectedCount || 5}`;
  if (viewerComparisonTitle) {
    viewerComparisonTitle.textContent = isEditedFallback ? 'Edited Photos' : 'Original vs Cleaned';
  }
  if (viewerComparisonCount) viewerComparisonCount.textContent = String(comparisonFiles.length);
  viewerOrthophotoGrid.innerHTML = '';
  if (viewerComparisonGrid) viewerComparisonGrid.innerHTML = '';
  viewerMetrics.innerHTML = '';

  const metricTopArea = calculateMetricTopArea(
    topArea.result,
    glbModelDimensions.result,
    referenceScaleDimensions,
  );
  if (metricTopArea) {
    viewerMetrics.appendChild(metricSection('Top Visible Area Estimate', [
      {
        label: '3D visible area',
        value: `${metricTopArea.areaM2.toFixed(2)} m²`,
      },
      {
        label: '2D projected area',
        value: `${metricTopArea.projectedAreaM2.toFixed(2)} m²`,
      },
    ]));
  }

  if (referenceScale.exists && referenceScaleDimensions) {
    const frontWidthMeters = Number(referenceScaleDimensions.front_width_m);
    const buildingLengthMeters = Number(referenceScaleDimensions.building_length_m);
    const buildingFootprintArea = frontWidthMeters * buildingLengthMeters;
    viewerMetrics.appendChild(metricSection('Estimated Building Dimensions', [
      {
        label: 'front width meters',
        value: `${formatNumber(referenceScaleDimensions.front_width_m, 2)} m`,
      },
      {
        label: 'building length meters',
        value: `${formatNumber(referenceScaleDimensions.building_length_m, 2)} m`,
      },
      {
        label: 'estimated area',
        value: Number.isFinite(buildingFootprintArea) ? `${buildingFootprintArea.toFixed(2)} m²` : '-',
      },
    ]));
  }

  for (const file of files) {
    viewerOrthophotoGrid.appendChild(renderPhotoCard(file, faceLabel(file.fileName)));
  }

  if (referenceScale.file) {
    viewerOrthophotoGrid.appendChild(renderPhotoCard(referenceScale.file, 'Reference scale', false));
  }

  if (!files.length && !referenceScale.file) {
    const empty = document.createElement('div');
    empty.className = 'viewer-empty-state';
    empty.textContent = 'No orthophotos have been created yet.';
    viewerOrthophotoGrid.appendChild(empty);
  }

  if (viewerComparisonGrid) {
    for (const file of comparisonFiles) {
      viewerComparisonGrid.appendChild(renderPhotoCard(file, faceLabel(file.fileName), false));
    }

    if (!comparisonFiles.length) {
      const empty = document.createElement('div');
      empty.className = 'viewer-empty-state';
      empty.textContent = isEditedFallback
        ? 'No edited images are available yet.'
        : 'No comparison images are available yet.';
      viewerComparisonGrid.appendChild(empty);
    }
  }

  const statusLines = [];
  if (data.exists) statusLines.push('Orthophotos are ready.');
  else statusLines.push('Orthophotos are not available yet.');
  statusLines.push(referenceScale.exists ? 'Reference scale is ready.' : 'Reference scale is pending. Click an orthophoto to set it.');
  statusLines.push(topArea.exists ? 'Top visible area is ready.' : 'Top visible area is pending.');
  if (data.job && data.job.status === 'running') statusLines.push('Orthophoto job is still running.');
  if (topArea.job && topArea.job.status === 'running') statusLines.push('Top area job is still running.');
  insightsStatus.textContent = statusLines.join('\n');
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    const message = text.match(/<pre>(.*?)<\/pre>/s)?.[1] || text.slice(0, 160) || response.statusText;
    throw new Error(`HTTP ${response.status} from ${url}: ${message}`);
  }
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function renderProjectHeader(data) {
  if (!data) return;
  if (projectNameLabel) projectNameLabel.textContent = data.projectName || projectName;
  if (projectTitleInput) {
    projectTitleInput.value = data.projectTitle || '';
    projectTitleInput.placeholder = data.projectTitle ? '' : 'Untitled';
  }
  if (projectCommentsInput) {
    projectCommentsInput.value = data.projectComments || '';
  }
  if (projectCommentsStatus) {
    projectCommentsStatus.textContent = data.projectComments ? 'Comments loaded.' : 'No comments saved yet.';
  }
  if (viewerModelProvider && Object.prototype.hasOwnProperty.call(data, 'modelProvider')) {
    viewerModelProvider.textContent = `Model provider: ${providerLabel(data.modelProvider)}`;
  }
}

async function loadProjectMetadata() {
  if (!projectName || projectName === 'Project') return null;
  const data = await fetchJson(`/api/projects/${encodeURIComponent(projectName)}`);
  renderProjectHeader(data);
  return data;
}

async function saveProjectTitle() {
  if (!projectTitleInput || !projectTitleSave || !projectName || projectName === 'Project') return;
  const projectTitle = projectTitleInput.value.trim();
  projectTitleSave.disabled = true;
  projectTitleSave.textContent = 'Saving';
  try {
    const data = await fetchJson(`/api/projects/${encodeURIComponent(projectName)}/title`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectTitle }),
    });
    renderProjectHeader(data);
    projectTitleSave.textContent = 'Saved';
    setTimeout(() => {
      projectTitleSave.textContent = 'Save';
    }, 1200);
  } catch (error) {
    projectTitleSave.textContent = 'Error';
    insightsStatus.textContent = `Could not update project title: ${error.message}`;
  } finally {
    projectTitleSave.disabled = false;
  }
}

async function saveProjectComments() {
  if (!projectCommentsInput || !projectCommentsSave || !projectName || projectName === 'Project') return;
  const projectComments = projectCommentsInput.value;
  projectCommentsSave.disabled = true;
  projectCommentsSave.textContent = 'Saving';
  if (projectCommentsStatus) projectCommentsStatus.textContent = 'Saving comments...';
  try {
    const data = await fetchJson(`/api/projects/${encodeURIComponent(projectName)}/comments`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectComments }),
    });
    renderProjectHeader(data);
    projectCommentsSave.textContent = 'Saved';
    if (projectCommentsStatus) {
      projectCommentsStatus.textContent = data.projectComments ? 'Comments saved.' : 'No comments saved yet.';
    }
    setTimeout(() => {
      projectCommentsSave.textContent = 'Save comments';
    }, 1200);
  } catch (error) {
    projectCommentsSave.textContent = 'Error';
    if (projectCommentsStatus) projectCommentsStatus.textContent = `Could not save comments: ${error.message}`;
  } finally {
    projectCommentsSave.disabled = false;
  }
}

async function loadInsights() {
  if (!projectName || projectName === 'Project') return;
  insightsStatus.textContent = 'Loading computed outputs...';
  try {
    const data = await fetchJson(`/api/projects/${encodeURIComponent(projectName)}/orthophotos/status`);
    renderInsights(data);
    return data;
  } catch (error) {
    insightsStatus.textContent = `Could not load computed outputs: ${error.message}`;
    setOrthophotosLink(false);
    throw error;
  }
}

function startInsightsPolling() {
  if (insightsPollTimer) return;
  insightsPollTimer = setInterval(async () => {
    try {
      const data = await loadInsights();
      const referenceJob = data && data.referenceScale && data.referenceScale.job;
      if (!referenceJob || referenceJob.status === 'completed' || referenceJob.status === 'failed') {
        clearInterval(insightsPollTimer);
        insightsPollTimer = null;
      }
    } catch (_error) {
      clearInterval(insightsPollTimer);
      insightsPollTimer = null;
    }
  }, 2500);
}

async function refreshHumanScale() {
  const files = currentInsightsData && currentInsightsData.files ? currentInsightsData.files : [];
  const frontFile = files.find((file) => /_front\.png$/i.test(file.fileName));
  const selectedFile = frontFile || files[0];
  if (!selectedFile) {
    throw new Error('Create orthophotos before setting a reference scale.');
  }
  await openScaleModal(selectedFile);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${file.fileName}.`));
    image.src = `${file.url}?v=${Date.now()}`;
  });
}

function drawScaleCanvas() {
  if (!scaleCanvas || !scaleState.image) return;
  const context = scaleCanvas.getContext('2d');
  context.clearRect(0, 0, scaleCanvas.width, scaleCanvas.height);
  context.drawImage(scaleState.image, 0, 0);

  const [start, end] = scaleState.points;
  const activeEnd = end || scaleState.previewPoint;
  if (!start || !activeEnd) return;

  context.save();
  context.lineWidth = Math.max(3, Math.round(Math.min(scaleCanvas.width, scaleCanvas.height) * 0.004));
  context.strokeStyle = '#22d3ee';
  context.fillStyle = '#22d3ee';
  context.shadowColor = 'rgba(0, 0, 0, 0.65)';
  context.shadowBlur = 5;
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(activeEnd.x, activeEnd.y);
  context.stroke();

  for (const point of [start, activeEnd]) {
    context.beginPath();
    context.arc(point.x, point.y, Math.max(5, context.lineWidth * 1.4), 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function canvasPointFromEvent(event) {
  const rect = scaleCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (scaleCanvas.width / rect.width),
    y: (event.clientY - rect.top) * (scaleCanvas.height / rect.height),
  };
}

function selectedPixelDistance() {
  const [start, end] = scaleState.points;
  if (!start || !end) return null;
  return Math.hypot(end.x - start.x, end.y - start.y);
}

function updateScalePixelDistance() {
  const distance = selectedPixelDistance();
  scalePixelDistance.textContent = distance
    ? `Selected reference line: ${distance.toFixed(1)} px`
    : 'No reference line selected.';
  scaleSaveButton.disabled = !distance;
}

function resetScaleLine() {
  scaleState.points = [];
  scaleState.previewPoint = null;
  updateScalePixelDistance();
  drawScaleCanvas();
}

async function openScaleModal(file) {
  if (!scaleModal || !scaleCanvas) return;
  scaleState = {
    file,
    image: await loadImage(file),
    points: [],
    previewPoint: null,
  };
  scaleModalTitle.textContent = `Set Reference Scale: ${faceLabel(file.fileName)}`;
  scaleMetersInput.value = '';
  scaleCanvas.width = scaleState.image.naturalWidth || scaleState.image.width;
  scaleCanvas.height = scaleState.image.naturalHeight || scaleState.image.height;
  scaleModal.classList.remove('is-hidden');
  updateScalePixelDistance();
  drawScaleCanvas();
}

function closeScaleModal() {
  if (!scaleModal) return;
  scaleModal.classList.add('is-hidden');
}

function annotatedReferenceImage(knownMeters, pixelDistance) {
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = scaleCanvas.width;
  outputCanvas.height = scaleCanvas.height;
  const context = outputCanvas.getContext('2d');
  context.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
  context.drawImage(scaleState.image, 0, 0);

  const [start, end] = scaleState.points;
  const lineWidth = Math.max(4, Math.round(Math.min(outputCanvas.width, outputCanvas.height) * 0.005));
  const label = `${knownMeters.toFixed(2)} m (${pixelDistance.toFixed(1)} px)`;
  const fontSize = Math.max(18, Math.round(outputCanvas.width * 0.018));
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;

  context.save();
  context.lineWidth = lineWidth + 4;
  context.strokeStyle = 'rgba(0, 0, 0, 0.72)';
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();

  context.lineWidth = lineWidth;
  context.strokeStyle = '#22d3ee';
  context.fillStyle = '#22d3ee';
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  for (const point of [start, end]) {
    context.beginPath();
    context.arc(point.x, point.y, lineWidth * 1.7, 0, Math.PI * 2);
    context.fill();
  }

  context.font = `700 ${fontSize}px Inter, Arial, sans-serif`;
  const metrics = context.measureText(label);
  const padding = Math.round(fontSize * 0.42);
  const labelX = Math.max(0, Math.min(midX + padding, outputCanvas.width - metrics.width - padding * 2));
  const labelY = Math.max(fontSize + padding, Math.min(midY - padding, outputCanvas.height - padding));
  context.fillStyle = 'rgba(0, 0, 0, 0.78)';
  context.fillRect(labelX - padding, labelY - fontSize - padding, metrics.width + padding * 2, fontSize + padding * 2);
  context.fillStyle = '#ffffff';
  context.fillText(label, labelX, labelY);
  context.restore();

  return outputCanvas.toDataURL('image/png');
}

async function saveReferenceScale(event) {
  event.preventDefault();
  const pixelDistance = selectedPixelDistance();
  const knownMeters = Number(scaleMetersInput.value);
  if (!pixelDistance) {
    scalePixelDistance.textContent = 'Select two points before saving.';
    return;
  }
  if (!Number.isFinite(knownMeters) || knownMeters <= 0) {
    scalePixelDistance.textContent = 'Enter a valid reference length in meters.';
    return;
  }

  scaleSaveButton.disabled = true;
  scalePixelDistance.textContent = 'Saving reference scale...';
  const data = await fetchJson(`/api/projects/${encodeURIComponent(projectName)}/orthophotos/reference-scale`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sourceFileName: scaleState.file.fileName,
      knownMeters,
      pixelDistance,
      line: {
        start: scaleState.points[0],
        end: scaleState.points[1],
      },
      imageSize: {
        width: scaleCanvas.width,
        height: scaleCanvas.height,
      },
      annotatedImageDataUrl: annotatedReferenceImage(knownMeters, pixelDistance),
    }),
  });
  renderInsights(data);
  closeScaleModal();
}

if (!modelUrl) {
  loadingPanel.textContent = 'No GLB model URL was provided.';
  throw new Error('Missing model URL.');
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6f6f6f);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(3.8, 2.6, 4.2);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.screenSpacePanning = true;
controls.minDistance = 0.5;
controls.maxDistance = 80;

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x3f3f46, 2.6);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(5, 8, 6);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xc7d2fe, 1.2);
fillLight.position.set(-5, 4, -4);
scene.add(fillLight);

const grid = new THREE.GridHelper(20, 20, 0x3f3f46, 0x303036);
grid.position.y = -0.01;
scene.add(grid);

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z) || 1;
  const fitDistance = maxSize / (2 * Math.tan((camera.fov * Math.PI) / 360));

  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= box.min.y;

  const groundedBox = new THREE.Box3().setFromObject(object);
  const groundedCenter = groundedBox.getCenter(new THREE.Vector3());
  controls.target.set(0, Math.max(groundedCenter.y, size.y * 0.35), 0);
  camera.position.set(fitDistance * 0.95, fitDistance * 0.62, fitDistance * 1.05);
  camera.near = Math.max(fitDistance / 100, 0.01);
  camera.far = fitDistance * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', resize);
resize();
animate();
loadProjectMetadata().catch((error) => {
  if (projectTitleInput) projectTitleInput.placeholder = 'Untitled';
  console.warn(error);
});
loadInsights().catch(() => {});
refreshInsightsButton.addEventListener('click', () => {
  loadInsights().catch(() => {});
});

if (projectTitleSave) {
  projectTitleSave.addEventListener('click', () => {
    saveProjectTitle().catch((error) => {
      insightsStatus.textContent = `Could not update project title: ${error.message}`;
    });
  });
}

if (projectTitleInput) {
  projectTitleInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    saveProjectTitle().catch((error) => {
      insightsStatus.textContent = `Could not update project title: ${error.message}`;
    });
  });
}

if (projectCommentsSave) {
  projectCommentsSave.addEventListener('click', () => {
    saveProjectComments().catch((error) => {
      if (projectCommentsStatus) projectCommentsStatus.textContent = `Could not save comments: ${error.message}`;
    });
  });
}

if (refreshHumanScaleButton) {
  refreshHumanScaleButton.addEventListener('click', () => {
    refreshHumanScale().catch((error) => {
      insightsStatus.textContent = `Could not open reference scale editor: ${error.message}`;
      refreshHumanScaleButton.disabled = false;
    });
  });
}

if (scaleCanvas) {
  scaleCanvas.addEventListener('pointermove', (event) => {
    if (scaleState.points.length !== 1) return;
    scaleState.previewPoint = canvasPointFromEvent(event);
    drawScaleCanvas();
  });

  scaleCanvas.addEventListener('pointerleave', () => {
    scaleState.previewPoint = null;
    drawScaleCanvas();
  });

  scaleCanvas.addEventListener('click', (event) => {
    if (!scaleState.image) return;
    const point = canvasPointFromEvent(event);
    if (scaleState.points.length >= 2) {
      scaleState.points = [point];
    } else {
      scaleState.points.push(point);
    }
    scaleState.previewPoint = null;
    updateScalePixelDistance();
    drawScaleCanvas();
  });
}

if (scaleModalCloseButton) {
  scaleModalCloseButton.addEventListener('click', closeScaleModal);
}

if (scaleResetButton) {
  scaleResetButton.addEventListener('click', resetScaleLine);
}

if (scaleForm) {
  scaleForm.addEventListener('submit', (event) => {
    saveReferenceScale(event).catch((error) => {
      scalePixelDistance.textContent = `Could not save reference scale: ${error.message}`;
      scaleSaveButton.disabled = false;
    });
  });
}

if (scaleModal) {
  scaleModal.addEventListener('click', (event) => {
    if (event.target === scaleModal) closeScaleModal();
  });
}

const loader = new GLTFLoader();
loader.load(
  modelUrl,
  (gltf) => {
    const model = gltf.scene;
    scene.add(model);
    frameObject(model);
    subtitle.textContent = 'Drag to rotate. Scroll to zoom. Right drag to pan.';
    loadingPanel.classList.add('is-hidden');
  },
  (event) => {
    if (!event.total) return;
    const progress = Math.round((event.loaded / event.total) * 100);
    loadingPanel.textContent = `Loading 3D model... ${progress}%`;
  },
  (error) => {
    console.error(error);
    subtitle.textContent = 'Failed to load model.';
    loadingPanel.textContent = `Failed to load GLB: ${error.message || error}`;
  },
);
