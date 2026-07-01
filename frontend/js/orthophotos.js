const pageTitle = document.querySelector('#pageTitle');
const statusLog = document.querySelector('#statusLog');
const photoGrid = document.querySelector('#photoGrid');
const photoCount = document.querySelector('#photoCount');
const createButton = document.querySelector('#createButton');
const humanScaleButton = document.querySelector('#humanScaleButton');
const deleteHumanScaleButton = document.querySelector('#deleteHumanScaleButton');
const topAreaButton = document.querySelector('#topAreaButton');
const refreshButton = document.querySelector('#refreshButton');
const viewerLink = document.querySelector('#viewerLink');
const topAreaCard = document.querySelector('#topAreaCard');
const topAreaValue = document.querySelector('#topAreaValue');
const topProjectedAreaValue = document.querySelector('#topProjectedAreaValue');
const topVisibleFacesValue = document.querySelector('#topVisibleFacesValue');
const topAreaMetersCard = document.querySelector('#topAreaMetersCard');
const topAreaMetersValue = document.querySelector('#topAreaMetersValue');
const topProjectedAreaMetersValue = document.querySelector('#topProjectedAreaMetersValue');
const glbDimensionsCard = document.querySelector('#glbDimensionsCard');
const glbWidthValue = document.querySelector('#glbWidthValue');
const glbLengthValue = document.querySelector('#glbLengthValue');
const glbHeightValue = document.querySelector('#glbHeightValue');
const buildingDimensionsCard = document.querySelector('#buildingDimensionsCard');
const frontWidthMetersValue = document.querySelector('#frontWidthMetersValue');
const buildingLengthMetersValue = document.querySelector('#buildingLengthMetersValue');
const buildingAreaValue = document.querySelector('#buildingAreaValue');

const params = new URLSearchParams(window.location.search);
const projectName = params.get('project');
const shouldStart = params.get('start') === '1';
let pollTimer = null;
let activeJobType = 'orthophotos';

function setLog(message) {
  statusLog.textContent = message;
}

function faceLabel(fileName) {
  const match = fileName.match(/_(front|back|right|left|top|bottom)\.png$/i);
  return match ? match[1] : fileName.replace(/\.png$/i, '');
}

function renderPhotos(files, expectedCount, humanScaleFile) {
  photoCount.textContent = `${files.length} / ${expectedCount || 5}`;
  photoGrid.innerHTML = '';

  if (!files.length && !humanScaleFile) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No orthophotos have been created yet.';
    photoGrid.appendChild(empty);
    return;
  }

  for (const file of files) {
    const card = document.createElement('article');
    card.className = 'photo-card';

    const heading = document.createElement('h3');
    heading.textContent = faceLabel(file.fileName);

    const image = document.createElement('img');
    image.src = `${file.url}?v=${Date.now()}`;
    image.alt = `${faceLabel(file.fileName)} orthophoto`;
    image.loading = 'lazy';

    card.appendChild(heading);
    card.appendChild(image);
    photoGrid.appendChild(card);
  }

  if (humanScaleFile) {
    const card = document.createElement('article');
    card.className = 'photo-card photo-card-human-scale';

    const heading = document.createElement('h3');
    heading.textContent = 'Human scale';

    const image = document.createElement('img');
    image.src = `${humanScaleFile.url}?v=${Date.now()}`;
    image.alt = 'Front orthophoto with human scale marker';
    image.loading = 'lazy';

    card.appendChild(heading);
    card.appendChild(image);
    photoGrid.appendChild(card);
  }
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
    modelTopRectangleUnits2,
    estimatedTopRectangleM2,
  };
}

function renderState(data) {
  const humanScale = data.humanScale || {};
  const topArea = data.topArea || {};
  renderPhotos(data.files || [], data.expectedCount, humanScale.file);

  const orthoRunning = data.job && data.job.status === 'running';
  const humanRunning = humanScale.job && humanScale.job.status === 'running';
  const topAreaRunning = topArea.job && topArea.job.status === 'running';
  const humanExists = Boolean(humanScale.exists);

  createButton.disabled = orthoRunning;
  humanScaleButton.disabled = !data.exists || humanRunning || humanExists;
  humanScaleButton.textContent = humanExists ? 'Human Scale Created' : humanRunning ? 'Creating Human Scale...' : 'Create Human Scale';
  deleteHumanScaleButton.classList.toggle('is-hidden', !humanExists);
  deleteHumanScaleButton.disabled = !humanExists || humanRunning;
  topAreaButton.disabled = topAreaRunning;
  topAreaButton.textContent = topAreaRunning ? 'Calculating Top Area...' : topArea.exists ? 'Recalculate Top Area' : 'Calculate Top Area';

  const glbDimensions = data.glbModelDimensions || {};
  topAreaCard.classList.add('is-hidden');
  glbDimensionsCard.classList.add('is-hidden');

  const dimensions = humanScale.metadata && humanScale.metadata.building_dimensions;
  if (humanExists && dimensions) {
    const frontWidthMeters = Number(dimensions.front_width_m);
    const buildingLengthMeters = Number(dimensions.building_length_m);
    const buildingArea = frontWidthMeters * buildingLengthMeters;
    buildingDimensionsCard.classList.remove('is-hidden');
    frontWidthMetersValue.textContent = `${Number(dimensions.front_width_m || 0).toFixed(2)} m`;
    buildingLengthMetersValue.textContent = `${Number(dimensions.building_length_m || 0).toFixed(2)} m`;
    buildingAreaValue.textContent = Number.isFinite(buildingArea) ? `${buildingArea.toFixed(2)} m²` : '-';
  } else {
    buildingDimensionsCard.classList.add('is-hidden');
  }

  const metricTopArea = calculateMetricTopArea(
    topArea.result,
    glbDimensions.result,
    dimensions,
  );
  if (metricTopArea) {
    topAreaMetersCard.classList.remove('is-hidden');
    topAreaMetersValue.textContent = `${metricTopArea.areaM2.toFixed(2)} m²`;
    topProjectedAreaMetersValue.textContent = `${metricTopArea.projectedAreaM2.toFixed(2)} m²`;
  } else {
    topAreaMetersCard.classList.add('is-hidden');
  }

  const job = activeJobType === 'humanScale' ? humanScale.job : activeJobType === 'topArea' ? topArea.job : data.job;
  if (!job) {
    if (activeJobType === 'humanScale' && humanExists) {
      setLog('Human scale image is ready.');
    } else if (activeJobType === 'topArea' && topArea.exists) {
      setLog('Top visible area measurement is ready.');
    } else {
      setLog(data.exists ? 'Orthophotos are ready.' : 'Orthophotos have not been created yet.');
    }
    createButton.disabled = false;
    createButton.textContent = data.exists ? 'Refresh Orthophotos' : 'Create Orthophotos';
    return;
  }

  const lines = [
    `Project: ${data.projectName}`,
    `Status: ${job.status}`,
    job.pid ? `PID: ${job.pid}` : null,
    job.exitCode !== null ? `Exit code: ${job.exitCode}` : null,
    job.logPath ? `Log: ${job.logPath}` : null,
    '',
    ...(job.logs || []),
  ].filter((line) => line !== null);

  setLog(lines.join('\n'));
  createButton.disabled = job.status === 'running';
  if (activeJobType === 'orthophotos') {
    createButton.textContent = job.status === 'running' ? 'Creating...' : data.exists ? 'Refresh Orthophotos' : 'Create Orthophotos';
  }
  if (activeJobType === 'topArea') {
    topAreaButton.textContent = job.status === 'running' ? 'Calculating Top Area...' : topArea.exists ? 'Recalculate Top Area' : 'Calculate Top Area';
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function loadViewerLink() {
  try {
    const data = await fetchJson('/api/projects');
    const project = (data.projects || []).find((item) => item.name === projectName);
    const glbFile = project && project.glbFiles && project.glbFiles[0];
    if (glbFile) {
      const query = new URLSearchParams({
        model: glbFile.url,
        project: projectName,
      });
      viewerLink.href = `/viewer.html?${query.toString()}`;
    }
  } catch (error) {
    console.warn('Could not load viewer link.', error);
  }
}

async function refreshState() {
  if (!projectName) return;
  const data = await fetchJson(`/api/projects/${encodeURIComponent(projectName)}/orthophotos/status`);
  renderState(data);

  const selectedJob = activeJobType === 'humanScale'
    ? data.humanScale && data.humanScale.job
    : activeJobType === 'topArea'
      ? data.topArea && data.topArea.job
      : data.job;
  const jobStatus = selectedJob && selectedJob.status;
  if (jobStatus === 'completed' || jobStatus === 'failed') {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  return data;
}

async function startOrthophotos() {
  if (!projectName) return;
  activeJobType = 'orthophotos';
  createButton.disabled = true;
  setLog('Starting orthophoto creation...');
  const data = await fetchJson(`/api/projects/${encodeURIComponent(projectName)}/orthophotos`, {
    method: 'POST',
  });
  renderState(data);
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      refreshState().catch((error) => setLog(`Status refresh failed: ${error.message}`));
    }, 2500);
  }
}

async function startHumanScale() {
  if (!projectName) return;
  activeJobType = 'humanScale';
  humanScaleButton.disabled = true;
  setLog('Starting human scale creation...');
  const data = await fetchJson(`/api/projects/${encodeURIComponent(projectName)}/orthophotos/human-scale`, {
    method: 'POST',
  });
  renderState(data);
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      refreshState().catch((error) => setLog(`Status refresh failed: ${error.message}`));
    }, 2500);
  }
}

async function deleteHumanScale() {
  if (!projectName) return;
  activeJobType = 'humanScale';
  deleteHumanScaleButton.disabled = true;
  setLog('Deleting human scale image...');
  const data = await fetchJson(`/api/projects/${encodeURIComponent(projectName)}/orthophotos/human-scale`, {
    method: 'DELETE',
  });
  renderState(data);
  setLog('Human scale image deleted. You can create it again.');
}

async function startTopArea() {
  if (!projectName) return;
  activeJobType = 'topArea';
  topAreaButton.disabled = true;
  setLog('Starting top visible area calculation...');
  const data = await fetchJson(`/api/projects/${encodeURIComponent(projectName)}/orthophotos/top-area`, {
    method: 'POST',
  });
  renderState(data);
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      refreshState().catch((error) => setLog(`Status refresh failed: ${error.message}`));
    }, 2500);
  }
}

async function init() {
  if (!projectName) {
    pageTitle.textContent = 'Missing project';
    setLog('No project was provided.');
    createButton.disabled = true;
    return;
  }

  pageTitle.textContent = `${projectName} Orthophotos`;
  await loadViewerLink();

  try {
    const data = await refreshState();
    if (shouldStart && !data.exists) {
      await startOrthophotos();
    }
  } catch (error) {
    setLog(error.message);
    createButton.disabled = false;
  }
}

createButton.addEventListener('click', () => {
  startOrthophotos().catch((error) => {
    setLog(error.message);
    createButton.disabled = false;
  });
});

humanScaleButton.addEventListener('click', () => {
  startHumanScale().catch((error) => {
    setLog(error.message);
    humanScaleButton.disabled = false;
  });
});

deleteHumanScaleButton.addEventListener('click', () => {
  deleteHumanScale().catch((error) => {
    setLog(error.message);
    deleteHumanScaleButton.disabled = false;
  });
});

topAreaButton.addEventListener('click', () => {
  startTopArea().catch((error) => {
    setLog(error.message);
    topAreaButton.disabled = false;
  });
});

refreshButton.addEventListener('click', () => {
  refreshState().catch((error) => setLog(error.message));
});

init();
