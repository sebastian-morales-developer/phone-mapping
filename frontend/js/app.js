const form = document.querySelector('#projectForm');
const formHint = document.querySelector('#formHint');
const healthBadge = document.querySelector('#healthBadge');
const projectsList = document.querySelector('#projectsList');
const refreshProjects = document.querySelector('#refreshProjects');
const exportProjectComments = document.querySelector('#exportProjectComments');
const statusPanel = document.querySelector('#statusPanel');
const statusSummary = document.querySelector('#statusSummary');
const statusBadge = document.querySelector('#statusBadge');
const submitButton = document.querySelector('#submitButton');
const individualPanel = document.querySelector('#individualPanel');
const batchPanel = document.querySelector('#batchPanel');
const generationModelPanel = document.querySelector('#generationModelPanel');
const imageSourcePanel = document.querySelector('#imageSourcePanel');
const projectTitleField = document.querySelector('#projectTitleField');
const projectTitleInput = form.querySelector('input[name="projectTitle"]');
const batchZipInput = form.querySelector('input[name="batch_zip"]');
const batchZipState = document.querySelector('#batchZipState');
const batchConfiguredContract = document.querySelector('#batchConfiguredContract');
const batchTwoModelsContract = document.querySelector('#batchTwoModelsContract');
const batchHyper3dRawContract = document.querySelector('#batchHyper3dRawContract');
const batchByModelContract = document.querySelector('#batchByModelContract');
const projectsPanel = document.querySelector('#projectsPanel');
const projectSubmitRow = document.querySelector('#projectSubmitRow');

const imageInputs = Array.from(form.querySelectorAll('input[type="file"]:not([name="batch_zip"])'));
const modeInputs = Array.from(form.querySelectorAll('input[name="production_mode"]'));
const providerInputs = Array.from(form.querySelectorAll('input[name="model_provider"]'));
const imageSourceInputs = Array.from(form.querySelectorAll('input[name="image_source"]'));
const providerExtraTiles = Array.from(form.querySelectorAll('[data-provider-only]'));
const frontInput = form.querySelector('input[name="front"]');
const frontPhotoActionMenu = document.querySelector('#frontPhotoActionMenu');
const cameraFallbackInput = document.querySelector('#cameraFallbackInput');
const cameraModal = document.querySelector('#cameraModal');
const cameraPreview = document.querySelector('#cameraPreview');
const cameraCanvas = document.querySelector('#cameraCanvas');
const cameraCompassBadge = document.querySelector('#cameraCompassBadge');
const cameraStatus = document.querySelector('#cameraStatus');
const cameraCloseButton = document.querySelector('#cameraCloseButton');
const cameraCaptureButton = document.querySelector('#cameraCaptureButton');
const cameraFallbackButton = document.querySelector('#cameraFallbackButton');
let activeProject = null;
let activeBatch = null;
let statusTimer = null;
let statusFetchFailures = 0;
let cameraStream = null;
let compassListenerActive = false;
let latestCompassReading = null;
let displayedCompassReading = null;
let frontPhotoCompassMetadata = null;
const uploadPreviewUrls = new WeakMap();
const acceptedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const HYPER3D_MAX_IMAGES = 5;
const COMPASS_DISPLAY_STEP_DEGREES = 5;
const VISIBLE_PRODUCTION_MODES = new Set(['individual', 'batch_by_model']);
const PIPELINE_STAGES = [
  {
    key: 'upload',
    label: 'Upload',
    detail: 'Files, project setup and image selection',
    patterns: [
      'Uploading images',
      'Uploading batch',
      'Created:',
      'Batch created',
      'Batch started',
      'Batch two-models started',
      'Batch Hyper3D raw started',
      'Detecting images',
      'Tencent orientation check',
      'OpenAI Hyper3D selection started',
      'Hyper3D selection method=',
      'Hyper3D raw selection method=',
    ],
  },
  {
    key: 'cleanup',
    label: 'OpenAI cleanup',
    detail: 'Obstacle removal and image cleanup',
    patterns: [
      'Photo Editing',
      'Editing:',
      'Photo elapsed:',
      'Photo editing done',
      'OpenAI photo editing is disabled',
      'Seeded raw images into output_photos/edited',
    ],
  },
  {
    key: 'generation',
    label: '3D generation',
    detail: 'Tencent Hunyuan or Hyper3D GLB',
    patterns: ['3D Model Generation', '3D generation elapsed:', 'Task ID:', 'GLB files:', 'Hyper3D', 'Hunyuan'],
  },
  {
    key: 'orthophotos',
    label: 'Orthophotos',
    detail: 'Front, back, side and top renders',
    patterns: ['Orthophoto renderer started', 'Rendering front:', 'Done. Images saved', 'Synchronized orthophoto dimensions'],
  },
  {
    key: 'measurements',
    label: 'Measurements',
    detail: 'Top visible area and dimensions',
    patterns: ['Calculate top visible area', 'Top area estimation started', 'Visible top 3D area', 'Projected top area'],
  },
  {
    key: 'completed',
    label: 'Final result',
    detail: 'GLB, orthophotos and metrics ready',
    patterns: ['Total pipeline elapsed:', 'Extended Phone Mapping pipeline finished', 'Pipeline finished with exit code 0'],
  },
  {
    key: 'batch_complete',
    label: 'Batch complete',
    detail: 'All ZIP subfolders and provider runs finished',
    patterns: ['Batch finished with status:'],
    batchOnly: true,
  },
];

function currentProductionMode() {
  return modeInputs.find((input) => input.checked)?.value || 'individual';
}

function currentProvider() {
  return providerInputs.find((input) => input.checked)?.value || 'tencent';
}

function currentImageSource() {
  return imageSourceInputs.find((input) => input.checked)?.value || 'ai_cleaned';
}

function ensureVisibleProductionMode() {
  const current = modeInputs.find((input) => input.checked);
  if (current && VISIBLE_PRODUCTION_MODES.has(current.value)) return;
  const fallback = modeInputs.find((input) => input.value === 'individual');
  if (fallback) fallback.checked = true;
}

function projectNumber(projectName) {
  const match = String(projectName || '').match(/^project_(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function frontPhotoIsRequired() {
  return currentProductionMode() === 'individual' && currentProvider() === 'tencent';
}

function providerLabel(modelProvider) {
  if (modelProvider === 'hyper3d') return 'Hyper3D';
  if (modelProvider === 'tencent') return 'Tencent';
  return 'Unknown';
}

function isInputActive(input) {
  const providerOnly = input.closest('[data-provider-only]');
  if (!providerOnly) return true;
  return providerOnly.dataset.providerOnly.split(/\s+/).includes(currentProvider());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.handleProjectPreviewError = function handleProjectPreviewError(image) {
  const holder = image.closest('.project-preview-media');
  if (holder) holder.innerHTML = '<span>No photo</span>';
};

function linesFromStatus(messageOrLines) {
  if (Array.isArray(messageOrLines)) return messageOrLines.filter(Boolean).map(String);
  return String(messageOrLines || '').split(/\r?\n/).filter((line) => line.length > 0);
}

function stageHasLog(stage, lines) {
  return lines.some((line) => stage.patterns.some((pattern) => line.includes(pattern)));
}

function cleanupWasSkipped(lines) {
  return lines.some((line) => (
    line.includes('--skip-photo-edit')
    || line.includes('Skip OpenAI photo editing: True')
    || line.includes('OpenAI photo editing is disabled')
    || line.includes('OpenAI cleanup skipped')
    || line.includes('without OpenAI cleanup')
  ));
}

function extractFirstMatch(lines, regex) {
  for (const line of lines) {
    const match = line.match(regex);
    if (match) return match[1].trim();
  }
  return null;
}

function stageTime(stageKey, lines) {
  if (stageKey === 'cleanup') {
    return extractFirstMatch(lines, /Photo editing done\..*Elapsed:\s*([^\]]+)$/)
      || extractFirstMatch(lines, /Photo editing done\..*Elapsed:\s*(.+)$/);
  }
  if (stageKey === 'generation') {
    return extractFirstMatch(lines, /3D generation elapsed:\s*(.+)$/);
  }
  if (stageKey === 'completed') {
    return extractFirstMatch(lines, /Total pipeline elapsed:\s*(.+)$/);
  }
  return null;
}

function stageStatus(stage, lines, overallTone) {
  if (stage.key === 'cleanup' && cleanupWasSkipped(lines)) return 'pending';

  if (overallTone === 'error') {
    if (stageHasLog(stage, lines)) return 'failed';
    return 'pending';
  }
  if (stage.key === 'completed' && overallTone === 'success') return 'completed';
  if (stageHasLog(stage, lines)) {
    if (
      stage.key === 'cleanup'
      && !lines.some((line) => line.includes('Photo editing done'))
    ) return 'running';
    if (
      stage.key === 'generation'
      && !lines.some((line) => line.includes('3D generation elapsed') || line.includes('GLB files:'))
    ) return 'running';
    if (
      stage.key === 'orthophotos'
      && !lines.some((line) => line.includes('Synchronized orthophoto dimensions') || line.includes('Done. Images saved'))
    ) return 'running';
    if (
      stage.key === 'measurements'
      && !lines.some((line) => line.includes('Projected top area') || line.includes('Saved:'))
    ) return 'running';
    return 'completed';
  }
  return 'pending';
}

function statusLabel(status) {
  if (status === 'completed') return 'Completed';
  if (status === 'running') return 'Running';
  if (status === 'failed') return 'Failed';
  return 'Pending';
}

function updateStatusBadge(tone, title) {
  statusBadge.className = 'pipeline-status-badge';
  if (tone === 'error') {
    statusBadge.classList.add('is-error');
    statusBadge.textContent = 'Failed';
  } else if (tone === 'success') {
    statusBadge.classList.add('is-success');
    statusBadge.textContent = 'Completed';
  } else {
    statusBadge.classList.add('is-running');
    statusBadge.textContent = title || 'Running';
  }
}

function renderStageCards(lines, tone = 'neutral') {
  const isBatch = lines.some((line) => line.includes('Batch:') || line.includes('Batch created:') || line.includes('Batch finished with status:'));
  const stages = PIPELINE_STAGES.filter((stage) => !stage.batchOnly || isBatch);
  statusSummary.innerHTML = stages.map((stage) => {
    const state = stageStatus(stage, lines, tone);
    const time = stageTime(stage.key, lines);
    return `
      <article class="pipeline-stage-card stage-${stage.key} is-${state}">
        <div class="stage-card-topline">
          <span class="stage-dot" aria-hidden="true"></span>
          <span class="stage-state">${statusLabel(state)}</span>
        </div>
        <h3>${escapeHtml(stage.label)}</h3>
        <p>${escapeHtml(stage.detail)}</p>
        <div class="stage-time">${time ? escapeHtml(time) : '&mdash;'}</div>
      </article>
    `;
  }).join('');
}

function setStatus(message, tone = 'neutral') {
  const lines = linesFromStatus(message);
  renderStageCards(lines, tone);
  const badgeTitle = lines.some((line) => line.toLowerCase().includes('waiting')) ? 'Waiting' : undefined;
  updateStatusBadge(tone, badgeTitle);
  statusPanel.textContent = lines.length ? lines.join('\n') : 'Waiting for upload.';
}

function selectedFiles() {
  return imageInputs.filter((input) => isInputActive(input) && input.files && input.files.length > 0);
}

function shouldRenderUploadPreview(input) {
  return input?.files?.length
    && currentProductionMode() === 'individual'
    && currentProvider() === 'hyper3d'
    && isInputActive(input);
}

function clearUploadPreview(input) {
  const tile = input.closest('.upload-tile');
  const existingUrl = uploadPreviewUrls.get(input);
  if (existingUrl) {
    URL.revokeObjectURL(existingUrl);
    uploadPreviewUrls.delete(input);
  }
  tile.classList.remove('has-image-preview');
  tile.querySelector('.upload-image-preview')?.remove();
}

function renderUploadPreview(input, file) {
  const tile = input.closest('.upload-tile');
  clearUploadPreview(input);

  const preview = document.createElement('img');
  const previewUrl = URL.createObjectURL(file);
  preview.className = 'upload-image-preview';
  preview.src = previewUrl;
  preview.alt = `${input.name.replaceAll('_', ' ')} preview`;
  preview.loading = 'lazy';
  uploadPreviewUrls.set(input, previewUrl);
  tile.prepend(preview);
  tile.classList.add('has-image-preview');
}

function updateFileState(input) {
  const tile = input.closest('.upload-tile');
  const state = document.querySelector(`[data-state-for="${input.name}"]`);
  const file = input.files && input.files[0];

  tile.classList.toggle('is-filled', Boolean(file));
  if (!file) {
    clearUploadPreview(input);
    state.textContent = input.required ? 'Required' : 'Optional';
    return;
  }

  if (shouldRenderUploadPreview(input)) {
    renderUploadPreview(input, file);
  } else {
    clearUploadPreview(input);
  }

  const sizeMb = file.size / 1024 / 1024;
  state.textContent = `${file.name} · ${sizeMb.toFixed(2)} MB`;
}

function updateFormHint() {
  if (currentProductionMode() !== 'individual') {
    const file = batchZipInput && batchZipInput.files && batchZipInput.files[0];
    formHint.textContent = file ? `1 ZIP selected · ${file.name}` : '0 batch ZIP files selected';
    formHint.classList.remove('text-red-300');
    return;
  }

  const count = selectedFiles().length;
  if (currentProvider() === 'hyper3d') {
    formHint.textContent = count > HYPER3D_MAX_IMAGES
      ? `${count} images selected · Hyper3D will auto-select best ${HYPER3D_MAX_IMAGES}`
      : `${count} image${count === 1 ? '' : 's'} selected · Hyper3D uses up to ${HYPER3D_MAX_IMAGES}`;
    formHint.classList.remove('text-red-300');
    return;
  }
  formHint.textContent = `${count} image${count === 1 ? '' : 's'} selected`;
  formHint.classList.remove('text-red-300');
}

function syncProjectsPanelHeight() {
  if (!projectsPanel || !projectSubmitRow) return;

  if (window.matchMedia('(max-width: 1023px)').matches) {
    projectsPanel.style.removeProperty('--projects-panel-max-height');
    return;
  }

  const panelTop = projectsPanel.getBoundingClientRect().top + window.scrollY;
  const submitBottom = projectSubmitRow.getBoundingClientRect().bottom + window.scrollY;
  const maxHeight = Math.max(320, Math.round(submitBottom - panelTop));
  projectsPanel.style.setProperty('--projects-panel-max-height', `${maxHeight}px`);
}

function clearInput(input) {
  input.value = '';
  updateFileState(input);
}

function clearUploadedProjectFiles() {
  imageInputs.forEach((input) => {
    input.value = '';
    updateFileState(input);
  });
  clearFrontCompassMetadata('form_reset');
}

function clearBatchZipFile() {
  if (batchZipInput) batchZipInput.value = '';
  updateBatchZipState();
}

function updateProviderFields() {
  hideFrontPhotoMenu();
  if (!shouldUseFrontPhotoMenu(frontInput)) closeCameraModal();
  const provider = currentProvider();
  if (frontInput) {
    frontInput.required = frontPhotoIsRequired();
  }
  const showImageSource = currentProductionMode() === 'individual' || currentProductionMode() === 'batch_by_model';
  if (imageSourcePanel) {
    imageSourcePanel.hidden = !showImageSource;
    imageSourcePanel.style.display = showImageSource ? '' : 'none';
  }
  imageSourceInputs.forEach((input) => {
    input.disabled = !showImageSource;
  });
  for (const tile of providerExtraTiles) {
    const isVisible = tile.dataset.providerOnly.split(/\s+/).includes(provider);
    tile.hidden = !isVisible;
    if (!isVisible) {
      const input = tile.querySelector('input[type="file"]');
      if (input) clearInput(input);
    }
  }
  imageInputs.forEach((input) => {
    if (isInputActive(input)) updateFileState(input);
  });
  updateFormHint();
}

function updateBatchZipState() {
  if (!batchZipInput || !batchZipState) return;
  const tile = batchZipInput.closest('.upload-tile');
  const file = batchZipInput.files && batchZipInput.files[0];
  tile.classList.toggle('is-filled', Boolean(file));
  if (!file) {
    const mode = currentProductionMode();
    batchZipState.textContent = mode === 'batch_two_models' || mode === 'batch_hyper3d_raw' || mode === 'batch_by_model'
      ? 'Required. Each subfolder only needs named images; no JSON is required.'
      : 'Required. Each subfolder must include phone_mapping_project.json and named images.';
    return;
  }
  const sizeMb = file.size / 1024 / 1024;
  batchZipState.textContent = `${file.name} · ${sizeMb.toFixed(2)} MB`;
}

function updateProductionModeFields() {
  ensureVisibleProductionMode();
  hideFrontPhotoMenu();
  if (!shouldUseFrontPhotoMenu(frontInput)) closeCameraModal();
  const mode = currentProductionMode();
  const isBatch = mode !== 'individual';
  const isTwoModelsBatch = mode === 'batch_two_models';
  const isHyper3dRawBatch = mode === 'batch_hyper3d_raw';
  const isByModelBatch = mode === 'batch_by_model';
  const showGenerationModel = mode === 'individual' || isByModelBatch;
  individualPanel.hidden = isBatch;
  individualPanel.style.display = isBatch ? 'none' : '';
  batchPanel.hidden = !isBatch;
  batchPanel.style.display = isBatch ? '' : 'none';
  generationModelPanel.hidden = !showGenerationModel;
  generationModelPanel.style.display = showGenerationModel ? '' : 'none';
  if (projectTitleField) {
    projectTitleField.hidden = isBatch;
    projectTitleField.style.display = isBatch ? 'none' : '';
  }
  if (projectTitleInput) {
    projectTitleInput.disabled = isBatch;
  }
  for (const input of imageInputs) {
    input.disabled = isBatch;
  }
  if (batchZipInput) {
    batchZipInput.disabled = !isBatch;
  }
  if (batchConfiguredContract) {
    batchConfiguredContract.hidden = isTwoModelsBatch || isHyper3dRawBatch || isByModelBatch;
    batchConfiguredContract.style.display = isTwoModelsBatch || isHyper3dRawBatch || isByModelBatch ? 'none' : '';
  }
  if (batchTwoModelsContract) {
    batchTwoModelsContract.hidden = !isTwoModelsBatch;
    batchTwoModelsContract.style.display = isTwoModelsBatch ? '' : 'none';
  }
  if (batchHyper3dRawContract) {
    batchHyper3dRawContract.hidden = !isHyper3dRawBatch;
    batchHyper3dRawContract.style.display = isHyper3dRawBatch ? '' : 'none';
  }
  if (batchByModelContract) {
    batchByModelContract.hidden = !isByModelBatch;
    batchByModelContract.style.display = isByModelBatch ? '' : 'none';
  }
  const note = document.querySelector('#providerModeNote');
  if (note) {
    note.textContent = isTwoModelsBatch
      ? 'In Batch Production Two Models, each subfolder is evaluated automatically and can run Tencent, Hyper3D, or both.'
      : isHyper3dRawBatch
        ? 'In Batch Hyper3D Raw, each subfolder is evaluated automatically for Hyper3D only, using original images without OpenAI cleanup.'
        : isByModelBatch
        ? 'In Batch Production by Model, every subfolder uses the selected provider and image source.'
        : isBatch
        ? 'In Batch Production, each subfolder uses its own phone_mapping_project.json.'
        : 'In Individual Production, this selection controls one manually labeled project.';
  }
  submitButton.textContent = isBatch ? 'Create batch' : 'Create project';
  updateProviderFields();
  updateBatchZipState();
  updateFormHint();
  requestAnimationFrame(syncProjectsPanelHeight);
}

function assignDroppedFile(input, file) {
  if (!acceptedImageTypes.has(file.type)) {
    setStatus(`${file.name} is not a supported image. Use JPEG, PNG, or WebP.`, 'error');
    return;
  }

  if (input === frontInput) {
    clearFrontCompassMetadata('manual_file_selection');
  }

  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  updateFileState(input);
  updateFormHint();
}

function assignDroppedZip(file) {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    setStatus(`${file.name} is not a ZIP package. Use a .zip file.`, 'error');
    return;
  }
  const transfer = new DataTransfer();
  transfer.items.add(file);
  batchZipInput.files = transfer.files;
  updateBatchZipState();
  updateFormHint();
}

function shouldUseFrontPhotoMenu(input) {
  return input?.name === 'front'
    && currentProductionMode() === 'individual'
    && currentProvider() === 'hyper3d';
}

function hideFrontPhotoMenu() {
  if (!frontPhotoActionMenu) return;
  frontPhotoActionMenu.classList.add('is-hidden');
}

function showFrontPhotoMenu(anchor) {
  if (!frontPhotoActionMenu || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const menuWidth = 260;
  const left = Math.min(window.innerWidth - menuWidth - 12, Math.max(12, rect.left));
  const top = Math.min(window.innerHeight - 104, rect.bottom + 8);
  frontPhotoActionMenu.style.left = `${left}px`;
  frontPhotoActionMenu.style.top = `${Math.max(12, top)}px`;
  frontPhotoActionMenu.classList.remove('is-hidden');
}

function openFrontFilePicker() {
  hideFrontPhotoMenu();
  if (!frontInput) return;
  frontInput.click();
}

function setCameraStatus(message, type = 'neutral') {
  if (!cameraStatus) return;
  cameraStatus.textContent = message;
  cameraStatus.classList.toggle('is-error', type === 'error');
}

function directionLabelFromDegrees(degrees) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(normalizeDegrees(degrees) / 45) % directions.length;
  return directions[index];
}

function normalizeDegrees(value) {
  const degrees = Number(value);
  if (!Number.isFinite(degrees)) return null;
  return ((degrees % 360) + 360) % 360;
}

function angularDistanceDegrees(a, b) {
  const first = normalizeDegrees(a);
  const second = normalizeDegrees(b);
  if (first === null || second === null) return Infinity;
  const delta = Math.abs(first - second);
  return Math.min(delta, 360 - delta);
}

function formatHeadingForDisplay(degrees) {
  const normalized = normalizeDegrees(degrees);
  if (normalized === null) return 'Heading: unavailable';
  const rounded = Math.round(normalized);
  return `Heading: ${String(rounded).padStart(3, '0')}° N`;
}

function emptyCompassMetadata(reason = 'unavailable') {
  return {
    headingDegrees: null,
    headingLabel: null,
    source: null,
    accuracy: 'unavailable',
    capturedAt: null,
    reason,
  };
}

function setCompassBadge(message, type = 'muted') {
  if (!cameraCompassBadge) return;
  cameraCompassBadge.textContent = message;
  cameraCompassBadge.classList.toggle('is-muted', type === 'muted');
  cameraCompassBadge.classList.toggle('is-error', type === 'error');
}

function compassReadingFromEvent(event) {
  const webkitHeading = normalizeDegrees(event.webkitCompassHeading);
  if (webkitHeading !== null) {
    return {
      headingDegrees: webkitHeading,
      headingLabel: directionLabelFromDegrees(webkitHeading),
      source: 'webkitCompassHeading',
      accuracy: 'device',
      capturedAt: null,
      reason: null,
    };
  }

  const alpha = normalizeDegrees(event.alpha);
  if (alpha === null) return null;
  const heading = normalizeDegrees(360 - alpha);
  return {
    headingDegrees: heading,
    headingLabel: directionLabelFromDegrees(heading),
    source: event.type === 'deviceorientationabsolute' || event.absolute ? 'deviceorientationabsolute.alpha' : 'deviceorientation.alpha',
    accuracy: event.absolute || event.type === 'deviceorientationabsolute' ? 'device' : 'approximate',
    capturedAt: null,
    reason: event.absolute || event.type === 'deviceorientationabsolute' ? null : 'relative_orientation_fallback',
  };
}

function handleCompassOrientation(event) {
  const reading = compassReadingFromEvent(event);
  if (!reading || reading.headingDegrees === null) return;
  latestCompassReading = reading;

  if (
    displayedCompassReading
    && angularDistanceDegrees(displayedCompassReading.headingDegrees, reading.headingDegrees) < COMPASS_DISPLAY_STEP_DEGREES
  ) {
    return;
  }

  displayedCompassReading = reading;
  setCompassBadge(formatHeadingForDisplay(reading.headingDegrees), 'ready');
}

async function startCompassAccess() {
  latestCompassReading = null;
  displayedCompassReading = null;
  frontPhotoCompassMetadata = emptyCompassMetadata('not_captured');
  setCompassBadge('Compass starting...', 'muted');

  if (typeof window.DeviceOrientationEvent === 'undefined') {
    setCompassBadge('Compass unavailable', 'muted');
    frontPhotoCompassMetadata = emptyCompassMetadata('device_orientation_not_supported');
    return;
  }

  try {
    if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
      const permission = await window.DeviceOrientationEvent.requestPermission();
      if (permission !== 'granted') {
        setCompassBadge('Compass permission denied', 'error');
        frontPhotoCompassMetadata = emptyCompassMetadata('permission_denied');
        return;
      }
    }

    if (!compassListenerActive) {
      window.addEventListener('deviceorientationabsolute', handleCompassOrientation, true);
      window.addEventListener('deviceorientation', handleCompassOrientation, true);
      compassListenerActive = true;
    }

    setCompassBadge('Compass waiting...', 'muted');
  } catch (error) {
    setCompassBadge('Compass unavailable', 'muted');
    frontPhotoCompassMetadata = emptyCompassMetadata(error.message || 'permission_error');
  }
}

function stopCompassAccess() {
  if (!compassListenerActive) return;
  window.removeEventListener('deviceorientationabsolute', handleCompassOrientation, true);
  window.removeEventListener('deviceorientation', handleCompassOrientation, true);
  compassListenerActive = false;
}

function capturedCompassMetadata() {
  const capturedAt = new Date().toISOString();
  const reading = displayedCompassReading || latestCompassReading;
  if (!reading || reading.headingDegrees === null) {
    return {
      ...emptyCompassMetadata(frontPhotoCompassMetadata?.reason || 'no_heading_reading'),
      capturedAt,
    };
  }

  return {
    ...reading,
    headingDegrees: Number(reading.headingDegrees.toFixed(2)),
    capturedAt,
  };
}

function clearFrontCompassMetadata(reason = 'manual_file_selection') {
  frontPhotoCompassMetadata = emptyCompassMetadata(reason);
}

function stopCameraStream() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  if (cameraPreview) {
    cameraPreview.srcObject = null;
  }
}

function closeCameraModal() {
  stopCameraStream();
  stopCompassAccess();
  if (cameraModal) {
    cameraModal.classList.add('is-hidden');
  }
  setCameraStatus('Camera is not active.');
  setCompassBadge('Compass unavailable', 'muted');
}

function openCameraFallback() {
  hideFrontPhotoMenu();
  if (cameraFallbackInput) {
    cameraFallbackInput.value = '';
    cameraFallbackInput.click();
    return;
  }
  openFrontFilePicker();
}

async function openCameraModal() {
  hideFrontPhotoMenu();
  if (!cameraModal || !cameraPreview || !navigator.mediaDevices?.getUserMedia) {
    setStatus('Camera API is not available. Opening device file picker fallback.', 'neutral');
    openCameraFallback();
    return;
  }

  cameraModal.classList.remove('is-hidden');
  setCameraStatus('Requesting camera access...');
  await startCompassAccess();

  try {
    stopCameraStream();
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    cameraPreview.srcObject = cameraStream;
    await cameraPreview.play();
    setCameraStatus('Camera ready. Frame the front view and capture.');
  } catch (error) {
    closeCameraModal();
    setStatus(`Camera could not be opened: ${error.message}. Opening file picker fallback.`, 'error');
    openCameraFallback();
  }
}

async function captureFrontPhoto() {
  if (!frontInput || !cameraPreview || !cameraCanvas) return;
  if (!cameraPreview.videoWidth || !cameraPreview.videoHeight) {
    setCameraStatus('Camera is not ready yet.', 'error');
    return;
  }

  cameraCanvas.width = cameraPreview.videoWidth;
  cameraCanvas.height = cameraPreview.videoHeight;
  const context = cameraCanvas.getContext('2d');
  context.drawImage(cameraPreview, 0, 0, cameraCanvas.width, cameraCanvas.height);

  const blob = await new Promise((resolve) => {
    cameraCanvas.toBlob(resolve, 'image/jpeg', 0.92);
  });

  if (!blob) {
    setCameraStatus('Could not capture the photo. Try again or use the file picker.', 'error');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = new File([blob], `front_camera_${timestamp}.jpg`, { type: 'image/jpeg' });
  assignDroppedFile(frontInput, file);
  frontPhotoCompassMetadata = capturedCompassMetadata();
  closeCameraModal();
  const headingText = frontPhotoCompassMetadata.headingDegrees === null
    ? 'Compass heading unavailable; saved as null.'
    : `Compass heading saved: ${Math.round(frontPhotoCompassMetadata.headingDegrees)}° ${frontPhotoCompassMetadata.headingLabel}.`;
  setStatus(`Front photo captured and ready.\n${headingText}`, 'success');
}

function bindDropZone(input) {
  const tile = input.closest('.upload-tile');

  tile.addEventListener('click', (event) => {
    if (event.target === input || !shouldUseFrontPhotoMenu(input)) return;
    event.preventDefault();
    event.stopPropagation();
    showFrontPhotoMenu(tile);
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    tile.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      tile.classList.add('is-dragging');
    });
  });

  ['dragleave', 'dragend'].forEach((eventName) => {
    tile.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      tile.classList.remove('is-dragging');
    });
  });

  tile.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    tile.classList.remove('is-dragging');

    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    assignDroppedFile(input, file);
  });
}

function bindBatchDropZone() {
  if (!batchZipInput) return;
  const tile = batchZipInput.closest('.upload-tile');

  ['dragenter', 'dragover'].forEach((eventName) => {
    tile.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      tile.classList.add('is-dragging');
    });
  });

  ['dragleave', 'dragend'].forEach((eventName) => {
    tile.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      tile.classList.remove('is-dragging');
    });
  });

  tile.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    tile.classList.remove('is-dragging');

    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    assignDroppedZip(file);
  });
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const ready = data.hasOpenAiKey && (data.has3dAiStudioKey || data.hasHyper3dKey);
    healthBadge.textContent = ready ? 'Service ready' : 'Service missing API key';
    healthBadge.classList.toggle('text-emerald-300', ready);
    healthBadge.classList.toggle('text-amber-300', !ready);
  } catch (error) {
    healthBadge.textContent = 'Service offline';
    healthBadge.classList.add('text-red-300');
  }
}

async function loadProjects() {
  projectsList.innerHTML = '<li class="text-zinc-500">Loading...</li>';
  try {
    const response = await fetch('/api/projects');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    if (!data.projects.length) {
      projectsList.innerHTML = '<li class="text-zinc-500">No projects yet.</li>';
      syncProjectsPanelHeight();
      return;
    }

    const projects = [...data.projects].sort((a, b) => {
      const nameA = typeof a === 'string' ? a : a.name;
      const nameB = typeof b === 'string' ? b : b.name;
      return projectNumber(nameB) - projectNumber(nameA);
    });

    projectsList.innerHTML = projects
      .map((project) => {
        const projectName = typeof project === 'string' ? project : project.name;
        const projectTitle = typeof project === 'string' ? '' : project.projectTitle || '';
        const projectTitleLabel = projectTitle.trim() ? projectTitle : 'Untitled';
        const modelProvider = typeof project === 'string' ? null : project.modelProvider || null;
        const previewImage = typeof project === 'string' ? null : project.previewImage || project.frontPreview || null;
        const previewUrl = previewImage?.url || null;
        const glbFiles = typeof project === 'string' ? [] : project.glbFiles || [];
        const glbLinks = glbFiles.length
          ? glbFiles
              .map(
                (file) => {
                  const viewerUrl = `/viewer.html?model=${encodeURIComponent(file.url)}&project=${encodeURIComponent(projectName)}`;
                  return `
                    <div class="mt-2 flex flex-wrap gap-3">
                      <a class="inline-flex text-emerald-300 hover:text-emerald-200" href="${viewerUrl}">View 3D</a>
                    </div>
                  `;
                },
              )
              .join('')
          : '<span class="mt-2 block text-xs text-zinc-500">GLB pending</span>';

        return `
          <li class="project-preview-card border border-zinc-800 text-zinc-300">
            <div class="project-preview-media">
              ${previewUrl
                ? `<img
                    src="${previewUrl}"
                    alt="${escapeHtml(projectName)} project photo"
                    loading="lazy"
                    onerror="window.handleProjectPreviewError(this)"
                  >`
                : '<span>No photo</span>'}
            </div>
            <div class="project-preview-body">
              <div class="font-medium">
                ${escapeHtml(projectName)}
                <span class="project-provider-label">(${escapeHtml(providerLabel(modelProvider))})</span>
              </div>
              <div class="project-list-title ${projectTitle.trim() ? '' : 'is-empty'}">${escapeHtml(projectTitleLabel)}</div>
              ${glbLinks}
            </div>
          </li>
        `;
      })
      .join('');
    syncProjectsPanelHeight();
  } catch (error) {
    projectsList.innerHTML = `<li class="text-red-300">${error.message}</li>`;
    syncProjectsPanelHeight();
  }
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function fileNameFromContentDisposition(header) {
  const match = String(header || '').match(/filename="([^"]+)"/i);
  return match?.[1] || null;
}

async function exportCommentsJson() {
  const originalLabel = exportProjectComments.textContent;
  exportProjectComments.disabled = true;
  exportProjectComments.textContent = 'Exporting...';
  try {
    const response = await fetch('/api/projects/comments/export');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const fallbackName = `phone_mapping_project_comments_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const fileName = fileNameFromContentDisposition(response.headers.get('Content-Disposition')) || fallbackName;
    downloadBlob(blob, fileName);
  } catch (error) {
    setStatus(`Could not export project comments JSON: ${error.message}`);
  } finally {
    exportProjectComments.disabled = false;
    exportProjectComments.textContent = originalLabel;
  }
}

function renderJob(job) {
  const lines = [
    `Project: ${job.projectName}`,
    `Status: ${job.status}`,
    job.modelProvider ? `3D provider: ${job.modelProvider}` : null,
    job.pid ? `PID: ${job.pid}` : null,
    job.exitCode !== null ? `Exit code: ${job.exitCode}` : null,
    job.logPath ? `Log: ${job.logPath}` : null,
    '',
    ...(job.logs || []),
  ].filter((line) => line !== null);

  setStatus(lines.join('\n'), job.status === 'failed' ? 'error' : job.status === 'completed' ? 'success' : 'neutral');
}

function renderBatchJob(batch) {
  const projectLines = (batch.projects || []).map((project) => {
    const label = project.projectName ? `${project.projectName} (${project.sourceFolder})` : project.sourceFolder;
    const provider = project.modelProvider ? ` · ${project.modelProvider}` : '';
    const index = project.sourceIndex && project.sourceTotal ? ` · ${project.sourceIndex}/${project.sourceTotal}` : '';
    const title = project.projectTitle ? ` · ${project.projectTitle}` : '';
    const error = project.error ? ` · ${project.error}` : '';
    return `- ${label}: ${project.status}${index}${provider}${title}${error}`;
  });
  const lines = [
    `Batch: ${batch.batchId}`,
    batch.mode ? `Mode: ${batch.mode}` : null,
    `Status: ${batch.status}`,
    `Source: ${batch.originalName}`,
    batch.totalSourceFolders ? `Source folders: ${batch.totalSourceFolders}` : null,
    `Provider runs: ${batch.completedProjects}/${batch.totalProjects} completed · ${batch.failedProjects} failed · ${batch.skippedProjects || 0} skipped`,
    batch.runningProject ? `Running: ${batch.runningProject.sourceIndex || '?'} of ${batch.runningProject.sourceTotal || '?'} · ${batch.runningProject.modelProvider || 'provider'} · ${batch.runningProject.projectTitle || batch.runningProject.sourceFolder}` : null,
    '',
    ...projectLines,
    '',
    ...(batch.logs || []),
  ].filter((line) => line !== null);

  const isError = batch.status === 'failed' || batch.status === 'completed_with_errors';
  const isSuccess = batch.status === 'completed';
  setStatus(lines.join('\n'), isError ? 'error' : isSuccess ? 'success' : 'neutral');
}

async function pollProjectStatus(projectName) {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectName)}/status`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    statusFetchFailures = 0;
    renderJob(data);
    if (data.status === 'completed' || data.status === 'failed') {
      clearInterval(statusTimer);
      statusTimer = null;
      submitButton.disabled = false;
      await loadProjects();
    }
  } catch (error) {
    statusFetchFailures += 1;
    setStatus(
      [
        `Status refresh failed: ${error.message}`,
        activeProject ? `Project: ${activeProject}` : null,
        `Retry: ${statusFetchFailures}/5`,
      ].filter(Boolean).join('\n'),
      'error',
    );
    if (statusFetchFailures >= 5) {
      clearInterval(statusTimer);
      statusTimer = null;
      submitButton.disabled = false;
    }
  }
}

async function pollBatchStatus(batchId) {
  try {
    const response = await fetch(`/api/batches/${encodeURIComponent(batchId)}/status`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    statusFetchFailures = 0;
    renderBatchJob(data);
    if (['completed', 'completed_with_errors', 'failed'].includes(data.status)) {
      clearInterval(statusTimer);
      statusTimer = null;
      submitButton.disabled = false;
      await loadProjects();
    }
  } catch (error) {
    statusFetchFailures += 1;
    setStatus(
      [
        `Batch status refresh failed: ${error.message}`,
        activeBatch ? `Batch: ${activeBatch}` : null,
        `Retry: ${statusFetchFailures}/5`,
      ].filter(Boolean).join('\n'),
      'error',
    );
    if (statusFetchFailures >= 5) {
      clearInterval(statusTimer);
      statusTimer = null;
      submitButton.disabled = false;
    }
  }
}

function watchProject(projectName) {
  activeProject = projectName;
  activeBatch = null;
  statusFetchFailures = 0;
  if (statusTimer) clearInterval(statusTimer);
  pollProjectStatus(projectName);
  statusTimer = setInterval(() => pollProjectStatus(projectName), 3000);
}

function watchBatch(batchId) {
  activeBatch = batchId;
  activeProject = null;
  statusFetchFailures = 0;
  if (statusTimer) clearInterval(statusTimer);
  pollBatchStatus(batchId);
  statusTimer = setInterval(() => pollBatchStatus(batchId), 3000);
}

async function submitProject(event) {
  event.preventDefault();
  if (currentProductionMode() !== 'individual') {
    await submitBatch();
    return;
  }

  const provider = currentProvider();
  const selected = selectedFiles();
  const front = form.querySelector('input[name="front"]');
  if (provider === 'tencent' && (!front.files || !front.files.length)) {
    setStatus('front image is required.', 'error');
    return;
  }
  if (provider === 'hyper3d' && selected.length < 1) {
    setStatus('Hyper3D requires at least one image in any angle slot.', 'error');
    return;
  }

  const formData = new FormData();
  const imageSource = currentImageSource();
  const hyper3dBangEnabled = false;
  formData.append('model_provider', provider);
  formData.append('image_source', imageSource);
  formData.append('hyper3d_image_source', imageSource);
  formData.append('hyper3d_bang_enabled', String(hyper3dBangEnabled));
  formData.append('projectTitle', projectTitleInput ? projectTitleInput.value : '');
  formData.append('frontCompassMetadata', JSON.stringify(frontPhotoCompassMetadata || emptyCompassMetadata('not_captured')));
  for (const input of imageInputs) {
    if (!isInputActive(input)) continue;
    if (input.files && input.files[0]) {
      formData.append(input.name, input.files[0]);
    }
  }

  submitButton.disabled = true;
  setStatus(
    [
      'Uploading images and creating project...',
      `3D provider: ${provider}`,
      `Image source: ${imageSource === 'original' ? 'original images, OpenAI cleanup skipped' : 'AI-cleaned images'}`,
      provider === 'hyper3d' && selected.length > HYPER3D_MAX_IMAGES
        ? `Hyper3D selection: ${selected.length} uploaded images, auto-selecting best ${HYPER3D_MAX_IMAGES}.`
        : null,
    ].filter(Boolean).join('\n'),
  );

  try {
    const response = await fetch('/api/projects', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    setStatus(
      [
        `Created: ${data.projectName}`,
        `3D provider: ${data.modelProvider}`,
        data.imageSource ? `Image source: ${data.imageSource}` : null,
        `Images saved: ${data.savedImages.length}`,
        `Next: ${data.nextStep}`,
        'Pipeline started.',
      ].filter(Boolean).join('\n'),
      'success',
    );
    clearUploadedProjectFiles();
    if (projectTitleInput) projectTitleInput.value = '';
    updateProviderFields();
    updateFormHint();
    await loadProjects();
    watchProject(data.projectName);
  } catch (error) {
    setStatus(error.message, 'error');
    submitButton.disabled = false;
  }
}

async function submitBatch() {
  const submittedMode = currentProductionMode();
  const file = batchZipInput && batchZipInput.files && batchZipInput.files[0];
  if (!file) {
    setStatus('Batch ZIP package is required.', 'error');
    return;
  }
  if (!file.name.toLowerCase().endsWith('.zip')) {
    setStatus('Batch Production requires a .zip file.', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('batch_zip', file);
  const batchMode = submittedMode === 'batch_two_models'
    ? 'two_models'
    : submittedMode === 'batch_hyper3d_raw'
      ? 'hyper3d_raw'
      : submittedMode === 'batch_by_model'
      ? 'by_model'
      : 'configured';
  formData.append('batch_mode', batchMode);
  if (submittedMode === 'batch_by_model') {
    formData.append('model_provider', currentProvider());
    formData.append('image_source', currentImageSource());
  }

  submitButton.disabled = true;
  setStatus(
    [
      'Uploading batch package...',
      `Source: ${file.name}`,
      `Mode: ${batchMode}`,
      submittedMode === 'batch_by_model' ? `3D provider: ${currentProvider()}` : null,
      submittedMode === 'batch_by_model' ? `Image source: ${currentImageSource()}` : null,
    ].filter(Boolean).join('\n'),
  );

  try {
    const response = await fetch('/api/batches', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    setStatus(
      [
        `Batch created: ${data.batchId}`,
        `Source: ${data.originalName}`,
        `Status: ${data.status}`,
        'Batch pipeline started.',
      ].join('\n'),
      'success',
    );
    clearBatchZipFile();
    updateProductionModeFields();
    await loadProjects();
    watchBatch(data.batchId);
  } catch (error) {
    setStatus(error.message, 'error');
    submitButton.disabled = false;
  }
}

imageInputs.forEach((input) => {
  input.addEventListener('change', () => {
    if (input === frontInput) {
      clearFrontCompassMetadata('manual_file_selection');
    }
    updateFileState(input);
    updateFormHint();
  });
  bindDropZone(input);
});

providerInputs.forEach((input) => {
  input.addEventListener('change', () => {
    updateProviderFields();
    requestAnimationFrame(syncProjectsPanelHeight);
  });
});

modeInputs.forEach((input) => {
  input.addEventListener('change', updateProductionModeFields);
});

if (batchZipInput) {
  batchZipInput.addEventListener('change', () => {
    updateBatchZipState();
    updateFormHint();
  });
  bindBatchDropZone();
}

if (frontPhotoActionMenu) {
  frontPhotoActionMenu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-front-photo-action]');
    if (!button) return;
    const action = button.dataset.frontPhotoAction;
    if (action === 'upload') {
      openFrontFilePicker();
      return;
    }
    if (action === 'camera') {
      openCameraModal();
    }
  });
}

if (cameraFallbackInput) {
  cameraFallbackInput.addEventListener('change', () => {
    const file = cameraFallbackInput.files && cameraFallbackInput.files[0];
    if (!file || !frontInput) return;
    assignDroppedFile(frontInput, file);
    clearFrontCompassMetadata('camera_fallback_file_picker');
    setStatus('Front photo selected from camera/file picker and ready.', 'success');
  });
}

if (cameraCloseButton) {
  cameraCloseButton.addEventListener('click', closeCameraModal);
}

if (cameraFallbackButton) {
  cameraFallbackButton.addEventListener('click', () => {
    closeCameraModal();
    openCameraFallback();
  });
}

if (cameraCaptureButton) {
  cameraCaptureButton.addEventListener('click', captureFrontPhoto);
}

document.addEventListener('click', (event) => {
  if (!frontPhotoActionMenu || frontPhotoActionMenu.classList.contains('is-hidden')) return;
  if (frontPhotoActionMenu.contains(event.target)) return;
  if (event.target.closest('.angle-front')) return;
  hideFrontPhotoMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  hideFrontPhotoMenu();
  if (cameraModal && !cameraModal.classList.contains('is-hidden')) {
    closeCameraModal();
  }
});

form.addEventListener('submit', submitProject);
refreshProjects.addEventListener('click', loadProjects);
exportProjectComments.addEventListener('click', exportCommentsJson);
window.addEventListener('resize', syncProjectsPanelHeight);
window.addEventListener('beforeunload', () => {
  stopCameraStream();
  stopCompassAccess();
});

checkHealth();
loadProjects();
updateProductionModeFields();
setStatus('Waiting for upload.');
syncProjectsPanelHeight();
