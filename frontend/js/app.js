const form = document.querySelector('#projectForm');
const formHint = document.querySelector('#formHint');
const healthBadge = document.querySelector('#healthBadge');
const projectsList = document.querySelector('#projectsList');
const refreshProjects = document.querySelector('#refreshProjects');
const statusPanel = document.querySelector('#statusPanel');
const submitButton = document.querySelector('#submitButton');

const imageInputs = Array.from(form.querySelectorAll('input[type="file"]'));
let activeProject = null;
let statusTimer = null;
let statusFetchFailures = 0;
const acceptedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

function setStatus(message, tone = 'neutral') {
  statusPanel.textContent = message;
  statusPanel.classList.remove('text-red-300', 'text-emerald-300', 'text-zinc-400');
  if (tone === 'error') {
    statusPanel.classList.add('text-red-300');
  } else if (tone === 'success') {
    statusPanel.classList.add('text-emerald-300');
  } else {
    statusPanel.classList.add('text-zinc-400');
  }
}

function selectedFiles() {
  return imageInputs.filter((input) => input.files && input.files.length > 0);
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
  const count = selectedFiles().length;
  formHint.textContent = `${count} image${count === 1 ? '' : 's'} selected`;
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

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const ready = data.hasOpenAiKey && data.has3dAiStudioKey;
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
      return;
    }

    projectsList.innerHTML = data.projects
      .map((project) => {
        const projectName = typeof project === 'string' ? project : project.name;
        const glbFiles = typeof project === 'string' ? [] : project.glbFiles || [];
        const glbLinks = glbFiles.length
          ? glbFiles
              .map(
                (file) => {
                  const viewerUrl = `/viewer.html?model=${encodeURIComponent(file.url)}&project=${encodeURIComponent(projectName)}`;
                  return `
                    <div class="mt-2 flex flex-wrap gap-3">
                      <a class="inline-flex text-cyan-300 hover:text-cyan-200" href="${file.url}" download>Download GLB</a>
                      <a class="inline-flex text-emerald-300 hover:text-emerald-200" href="${viewerUrl}">View 3D</a>
                    </div>
                  `;
                },
              )
              .join('')
          : '<span class="mt-2 block text-xs text-zinc-500">GLB pending</span>';

        return `
          <li class="border border-zinc-800 px-3 py-2 text-zinc-300">
            <div class="font-medium">${projectName}</div>
            ${glbLinks}
          </li>
        `;
      })
      .join('');
  } catch (error) {
    projectsList.innerHTML = `<li class="text-red-300">${error.message}</li>`;
  }
}

function renderJob(job) {
  const lines = [
    `Project: ${job.projectName}`,
    `Status: ${job.status}`,
    job.pid ? `PID: ${job.pid}` : null,
    job.exitCode !== null ? `Exit code: ${job.exitCode}` : null,
    job.logPath ? `Log: ${job.logPath}` : null,
    '',
    ...(job.logs || []),
  ].filter((line) => line !== null);

  setStatus(lines.join('\n'), job.status === 'failed' ? 'error' : job.status === 'completed' ? 'success' : 'neutral');
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

function watchProject(projectName) {
  activeProject = projectName;
  statusFetchFailures = 0;
  if (statusTimer) clearInterval(statusTimer);
  pollProjectStatus(projectName);
  statusTimer = setInterval(() => pollProjectStatus(projectName), 3000);
}

async function submitProject(event) {
  event.preventDefault();
  const front = form.querySelector('input[name="front"]');
  if (!front.files || !front.files.length) {
    setStatus('front image is required.', 'error');
    return;
  }

  const formData = new FormData();
  for (const input of imageInputs) {
    if (input.files && input.files[0]) {
      formData.append(input.name, input.files[0]);
    }
  }

  submitButton.disabled = true;
  setStatus('Uploading images and creating project...');

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
        `Images saved: ${data.savedImages.length}`,
        `Next: ${data.nextStep}`,
        'Pipeline started.',
      ].join('\n'),
      'success',
    );
    form.reset();
    imageInputs.forEach(updateFileState);
    updateFormHint();
    await loadProjects();
    watchProject(data.projectName);
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

form.addEventListener('submit', submitProject);
refreshProjects.addEventListener('click', loadProjects);

checkHealth();
loadProjects();
updateFormHint();
