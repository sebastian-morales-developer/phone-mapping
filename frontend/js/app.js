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
const projectTitleField = document.querySelector('#projectTitleField');
const projectTitleInput = form.querySelector('input[name="projectTitle"]');
const batchZipInput = form.querySelector('input[name="batch_zip"]');
const batchZipState = document.querySelector('#batchZipState');
const batchConfiguredContract = document.querySelector('#batchConfiguredContract');
const batchTwoModelsContract = document.querySelector('#batchTwoModelsContract');
const projectsPanel = document.querySelector('#projectsPanel');
const projectSubmitRow = document.querySelector('#projectSubmitRow');

const imageInputs = Array.from(form.querySelectorAll('input[type="file"]:not([name="batch_zip"])'));
const modeInputs = Array.from(form.querySelectorAll('input[name="production_mode"]'));
const providerInputs = Array.from(form.querySelectorAll('input[name="model_provider"]'));
const providerExtraTiles = Array.from(form.querySelectorAll('[data-provider-only]'));
let activeProject = null;
let activeBatch = null;
let statusTimer = null;
let statusFetchFailures = 0;
const acceptedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const HYPER3D_MAX_IMAGES = 5;
const FRONT_PREVIEW_EXTENSIONS = ['jpeg', 'jpg', 'png', 'webp'];
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
      'Detecting images',
      'Tencent orientation check',
      'OpenAI Hyper3D selection started',
      'Hyper3D selection method=',
    ],
  },
  {
    key: 'cleanup',
    label: 'OpenAI cleanup',
    detail: 'Obstacle removal and image cleanup',
    patterns: ['Photo Editing', 'Editing:', 'Photo elapsed:', 'Photo editing done'],
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

function providerLabel(modelProvider) {
  if (modelProvider === 'hyper3d') return 'Hyper3D';
  if (modelProvider === 'tencent') return 'Tencent';
  return 'Unknown';
}

function isInputActive(input) {
  const providerOnly = input.closest('[data-provider-only]');
  return !providerOnly || providerOnly.dataset.providerOnly === currentProvider();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function frontPreviewFallbackUrl(projectName, extensionIndex = 0) {
  const extension = FRONT_PREVIEW_EXTENSIONS[extensionIndex] || FRONT_PREVIEW_EXTENSIONS[0];
  return `/projects/${encodeURIComponent(projectName)}/input_photos/front.${extension}`;
}

window.handleProjectPreviewError = function handleProjectPreviewError(image, projectName) {
  const currentIndex = Number(image.dataset.extensionIndex || '0');
  const nextIndex = currentIndex + 1;
  if (nextIndex < FRONT_PREVIEW_EXTENSIONS.length) {
    image.dataset.extensionIndex = String(nextIndex);
    image.src = frontPreviewFallbackUrl(projectName, nextIndex);
    return;
  }

  const holder = image.closest('.project-preview-media');
  if (holder) holder.innerHTML = '<span>No front photo</span>';
};

function linesFromStatus(messageOrLines) {
  if (Array.isArray(messageOrLines)) return messageOrLines.filter(Boolean).map(String);
  return String(messageOrLines || '').split(/\r?\n/).filter((line) => line.length > 0);
}

function stageHasLog(stage, lines) {
  return lines.some((line) => stage.patterns.some((pattern) => line.includes(pattern)));
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

function updateFileState(input) {
  const tile = input.closest('.upload-tile');
  const state = document.querySelector(`[data-state-for="${input.name}"]`);
  const file = input.files && input.files[0];

  tile.classList.toggle('is-filled', Boolean(file));
  if (!file) {
    state.textContent = input.required ? 'Required' : 'Optional';
    return;
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
    formHint.textContent = `${count} image${count === 1 ? '' : 's'} selected · Hyper3D max ${HYPER3D_MAX_IMAGES}`;
    formHint.classList.toggle('text-red-300', count > HYPER3D_MAX_IMAGES);
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

function updateProviderFields() {
  const provider = currentProvider();
  for (const tile of providerExtraTiles) {
    const isVisible = tile.dataset.providerOnly === provider;
    tile.hidden = !isVisible;
    if (!isVisible) {
      const input = tile.querySelector('input[type="file"]');
      if (input) clearInput(input);
    }
  }
  updateFormHint();
}

function updateBatchZipState() {
  if (!batchZipInput || !batchZipState) return;
  const tile = batchZipInput.closest('.upload-tile');
  const file = batchZipInput.files && batchZipInput.files[0];
  tile.classList.toggle('is-filled', Boolean(file));
  if (!file) {
    batchZipState.textContent = currentProductionMode() === 'batch_two_models'
      ? 'Required. Each subfolder only needs named images; no JSON is required.'
      : 'Required. Each subfolder must include phone_mapping_project.json and named images.';
    return;
  }
  const sizeMb = file.size / 1024 / 1024;
  batchZipState.textContent = `${file.name} · ${sizeMb.toFixed(2)} MB`;
}

function updateProductionModeFields() {
  const mode = currentProductionMode();
  const isBatch = mode !== 'individual';
  const isTwoModelsBatch = mode === 'batch_two_models';
  individualPanel.hidden = isBatch;
  individualPanel.style.display = isBatch ? 'none' : '';
  batchPanel.hidden = !isBatch;
  batchPanel.style.display = isBatch ? '' : 'none';
  generationModelPanel.hidden = isBatch;
  generationModelPanel.style.display = isBatch ? 'none' : '';
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
    batchConfiguredContract.hidden = isTwoModelsBatch;
    batchConfiguredContract.style.display = isTwoModelsBatch ? 'none' : '';
  }
  if (batchTwoModelsContract) {
    batchTwoModelsContract.hidden = !isTwoModelsBatch;
    batchTwoModelsContract.style.display = isTwoModelsBatch ? '' : 'none';
  }
  const note = document.querySelector('#providerModeNote');
  if (note) {
    note.textContent = isTwoModelsBatch
      ? 'In Batch Production Two Models, each subfolder is evaluated automatically and can run Tencent, Hyper3D, or both.'
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

function bindDropZone(input) {
  const tile = input.closest('.upload-tile');

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

    projectsList.innerHTML = data.projects
      .map((project) => {
        const projectName = typeof project === 'string' ? project : project.name;
        const projectTitle = typeof project === 'string' ? '' : project.projectTitle || '';
        const projectTitleLabel = projectTitle.trim() ? projectTitle : 'Untitled';
        const modelProvider = typeof project === 'string' ? null : project.modelProvider || null;
        const frontPreview = typeof project === 'string' ? null : project.frontPreview || null;
        const previewUrl = frontPreview?.url || frontPreviewFallbackUrl(projectName);
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
              <img
                src="${previewUrl}"
                alt="${escapeHtml(projectName)} front photo"
                loading="lazy"
                data-extension-index="0"
                onerror="window.handleProjectPreviewError(this, '${escapeHtml(projectName)}')"
              >
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

  const front = form.querySelector('input[name="front"]');
  if (!front.files || !front.files.length) {
    setStatus('front image is required.', 'error');
    return;
  }

  const formData = new FormData();
  const provider = currentProvider();
  const selected = selectedFiles();
  if (provider === 'hyper3d' && selected.length > HYPER3D_MAX_IMAGES) {
    setStatus(`Hyper3D accepts a maximum of ${HYPER3D_MAX_IMAGES} images. Remove ${selected.length - HYPER3D_MAX_IMAGES} image${selected.length - HYPER3D_MAX_IMAGES === 1 ? '' : 's'} before creating the project.`, 'error');
    return;
  }
  formData.append('model_provider', provider);
  formData.append('projectTitle', projectTitleInput ? projectTitleInput.value : '');
  for (const input of imageInputs) {
    if (!isInputActive(input)) continue;
    if (input.files && input.files[0]) {
      formData.append(input.name, input.files[0]);
    }
  }

  submitButton.disabled = true;
  setStatus(`Uploading images and creating project...\n3D provider: ${provider}`);

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
        `Images saved: ${data.savedImages.length}`,
        `Next: ${data.nextStep}`,
        'Pipeline started.',
      ].join('\n'),
      'success',
    );
    form.reset();
    imageInputs.forEach(updateFileState);
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
  formData.append('batch_mode', submittedMode === 'batch_two_models' ? 'two_models' : 'configured');

  submitButton.disabled = true;
  setStatus(
    [
      'Uploading batch package...',
      `Source: ${file.name}`,
      `Mode: ${submittedMode === 'batch_two_models' ? 'two_models' : 'configured'}`,
    ].join('\n'),
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
    form.reset();
    const batchModeInput = modeInputs.find((input) => input.value === submittedMode);
    if (batchModeInput) batchModeInput.checked = true;
    imageInputs.forEach(updateFileState);
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

form.addEventListener('submit', submitProject);
refreshProjects.addEventListener('click', loadProjects);
exportProjectComments.addEventListener('click', exportCommentsJson);
window.addEventListener('resize', syncProjectsPanelHeight);

checkHealth();
loadProjects();
updateProductionModeFields();
setStatus('Waiting for upload.');
syncProjectsPanelHeight();
