const cors = require('cors');
const dotenv = require('dotenv');
const express = require('express');
const fs = require('fs/promises');
const fsSync = require('fs');
const morgan = require('morgan');
const multer = require('multer');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
const PROJECTS_DIR = path.join(ROOT_DIR, 'projects');
const BATCH_UPLOADS_DIR = path.join(ROOT_DIR, 'batch_uploads');
const PYTHON_SERVICE = path.join(ROOT_DIR, 'python_services', 'run_extended_pipeline.py');
const ORTHOPHOTO_SERVICE = path.join(ROOT_DIR, 'python_services', 'create_orthophotos.py');
const HUMAN_SCALE_SERVICE = path.join(ROOT_DIR, 'python_services', 'create_human_scale.py');
const TOP_AREA_SERVICE = path.join(ROOT_DIR, 'python_services', 'calculate_top_area.py');
const DEFAULT_PYTHON_BIN = path.join(ROOT_DIR, '.venv', 'bin', 'python');
const DEFAULT_ORTHOPHOTO_PYTHON_BIN = path.join(ROOT_DIR, '.venv', 'bin', 'python');

const VIEW_FIELDS = ['front', 'left', 'right', 'back', 'left_front', 'right_front', 'back_left', 'back_right'];
const REQUIRED_FIELDS = new Set(['front']);
const MODEL_PROVIDERS = new Set(['tencent', 'hyper3d']);
const BATCH_MODES = new Set(['configured', 'two_models']);
const TENCENT_ALLOWED_VIEWS = ['front', 'left_front', 'right_front', 'left', 'right', 'back'];
const HYPER3D_SELECTION_ORDER = ['front', 'left_front', 'left', 'back_left', 'back', 'back_right', 'right', 'right_front'];
const TENCENT_INVERTED_VIEW = {
  front: 'back',
  left_front: 'back_right',
  left: 'right',
  back_left: 'right_front',
  back: 'front',
  back_right: 'left_front',
  right: 'left',
  right_front: 'back_left',
};
const IMAGE_MIME_TO_EXT = {
  'image/jpeg': '.jpeg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const jobs = new Map();
const batchJobs = new Map();
const orthophotoJobs = new Map();
const humanScaleJobs = new Map();
const topAreaJobs = new Map();
const execFileAsync = promisify(execFile);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: VIEW_FIELDS.length,
    fileSize: 25 * 1024 * 1024,
  },
  fileFilter: (_req, file, callback) => {
    if (!VIEW_FIELDS.includes(file.fieldname)) {
      callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
      return;
    }
    if (!IMAGE_MIME_TO_EXT[file.mimetype]) {
      callback(new Error(`Unsupported image type for ${file.fieldname}: ${file.mimetype}`));
      return;
    }
    callback(null, true);
  },
});

const batchUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 500 * 1024 * 1024,
  },
  fileFilter: (_req, file, callback) => {
    const lowerName = file.originalname.toLowerCase();
    const isZip = lowerName.endsWith('.zip')
      || file.mimetype === 'application/zip'
      || file.mimetype === 'application/x-zip-compressed';
    if (!isZip) {
      callback(new Error('Batch Production requires a .zip file.'));
      return;
    }
    callback(null, true);
  },
});

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '25mb' }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/projects', express.static(PROJECTS_DIR));
app.use(express.static(FRONTEND_DIR));

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function projectNumberExists(number) {
  try {
    const stats = await fs.stat(path.join(PROJECTS_DIR, `project_${number}`));
    return stats.isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function nextProjectName() {
  await ensureDir(PROJECTS_DIR);
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const usedNumbers = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => /^project_(\d+)$/.exec(entry.name))
    .filter(Boolean)
    .map((match) => Number(match[1]));

  let nextNumber = usedNumbers.length ? Math.max(...usedNumbers) + 1 : 1;
  while (await projectNumberExists(nextNumber)) {
    nextNumber += 1;
  }
  return `project_${nextNumber}`;
}

async function createProjectFolders(projectDir) {
  const folders = {
    inputPhotos: path.join(projectDir, 'input_photos'),
    outputPhotos: path.join(projectDir, 'output_photos'),
    edited: path.join(projectDir, 'output_photos', 'edited'),
    comparison: path.join(projectDir, 'output_photos', 'comparison'),
    orthophotos: path.join(projectDir, 'output_photos', 'orthophotos'),
    outputGlb: path.join(projectDir, 'output_glb'),
    logs: path.join(projectDir, 'logs'),
  };

  await Promise.all(Object.values(folders).map(ensureDir));
  return folders;
}

function filesByField(files) {
  const result = new Map();
  for (const file of files || []) {
    if (!result.has(file.fieldname)) {
      result.set(file.fieldname, file);
    }
  }
  return result;
}

function validateRequiredUploads(fileMap) {
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    if (!fileMap.has(field)) missing.push(field);
  }
  return missing;
}

async function saveUploadedImages(fileMap, inputPhotosDir) {
  const saved = [];

  for (const viewName of VIEW_FIELDS) {
    const file = fileMap.get(viewName);
    if (!file) continue;

    const extension = IMAGE_MIME_TO_EXT[file.mimetype];
    const fileName = `${viewName}${extension}`;
    const absolutePath = path.join(inputPhotosDir, fileName);
    await fs.writeFile(absolutePath, file.buffer);

    saved.push({
      view: viewName,
      fileName,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      path: absolutePath,
    });
  }

  return saved;
}

function normalizeViewToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function detectViewFromFileName(fileName) {
  const token = `_${normalizeViewToken(fileName)}_`;
  const patterns = [
    ['left_front', ['left_front', 'front_left']],
    ['right_front', ['right_front', 'front_right']],
    ['back_left', ['back_left', 'left_back']],
    ['back_right', ['back_right', 'right_back']],
    ['front', ['front']],
    ['left', ['left']],
    ['right', ['right']],
    ['back', ['back']],
  ];

  for (const [view, aliases] of patterns) {
    if (aliases.some((alias) => token.includes(`_${alias}_`))) {
      return view;
    }
  }
  return null;
}

function batchAllowedViews(modelProvider) {
  if (modelProvider === 'hyper3d') return VIEW_FIELDS;
  return ['front', 'left_front', 'right_front', 'left', 'right', 'back'];
}

function imageExtensionFromName(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) return extension;
  return null;
}

function imageMimeFromExtension(extension) {
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function directFilesInDir(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name));
}

async function scanViewImages(sourceDir, allowedViews = VIEW_FIELDS) {
  const allowedViewSet = new Set(allowedViews);
  const files = await directFilesInDir(sourceDir);
  const byView = new Map();
  const ignoredFiles = [];
  const duplicateFiles = [];

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const extension = imageExtensionFromName(fileName);
    if (!extension) {
      if (fileName !== 'phone_mapping_project.json') ignoredFiles.push(fileName);
      continue;
    }

    const view = detectViewFromFileName(fileName);
    if (!view || !allowedViewSet.has(view)) {
      ignoredFiles.push(fileName);
      continue;
    }
    if (byView.has(view)) {
      duplicateFiles.push({
        view,
        kept: byView.get(view).fileName,
        ignored: fileName,
      });
      ignoredFiles.push(fileName);
      continue;
    }
    byView.set(view, { filePath, fileName, extension });
  }

  return { byView, ignoredFiles, duplicateFiles };
}

function selectionFromViewMap(byView, selectedViews) {
  return selectedViews
    .filter((view) => byView.has(view))
    .map((view) => ({
      view,
      ...byView.get(view),
    }));
}

async function saveSelectedProjectImages(selectedImages, inputPhotosDir) {
  const saved = [];

  for (const source of selectedImages) {
    const fileName = `${source.view}${source.extension}`;
    const absolutePath = path.join(inputPhotosDir, fileName);
    await fs.copyFile(source.filePath, absolutePath);
    const stats = await fs.stat(absolutePath);
    saved.push({
      view: source.view,
      fileName,
      originalName: source.fileName,
      size: stats.size,
      path: absolutePath,
    });
  }

  return saved;
}

async function copyIfExists(sourcePath, targetPath) {
  try {
    await fs.access(sourcePath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  await ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
  return true;
}

async function buildEditedReuseMap(projectDir, selectedImages) {
  const editedDir = path.join(projectDir, 'output_photos', 'edited');
  const comparisonDir = path.join(projectDir, 'output_photos', 'comparison');
  const reuseMap = new Map();

  for (const image of selectedImages) {
    const sourceView = image.sourceView || image.view;
    const projectView = image.view;
    const editedPath = path.join(editedDir, `${projectView}_edited.png`);
    const comparisonPath = path.join(comparisonDir, `${projectView}_comparison.png`);
    const editedExists = fsSync.existsSync(editedPath);
    const comparisonExists = fsSync.existsSync(comparisonPath);
    if (!editedExists || !comparisonExists) continue;
    reuseMap.set(sourceView, {
      sourceView,
      projectView,
      editedPath,
      comparisonPath,
    });
  }

  return reuseMap;
}

async function reuseEditedOutputsForProject({
  targetProjectDir,
  selectedImages,
  reuseMap,
  batchJob,
  sourceFolder,
  modelProvider,
}) {
  if (!reuseMap || !reuseMap.size) {
    return { reused: [], missing: selectedImages.map((image) => image.view) };
  }

  const editedDir = path.join(targetProjectDir, 'output_photos', 'edited');
  const comparisonDir = path.join(targetProjectDir, 'output_photos', 'comparison');
  const reused = [];
  const missing = [];

  for (const image of selectedImages) {
    const sourceView = image.sourceView || image.view;
    const reusable = reuseMap.get(sourceView);
    if (!reusable) {
      missing.push(image.view);
      continue;
    }

    const editedTarget = path.join(editedDir, `${image.view}_edited.png`);
    const comparisonTarget = path.join(comparisonDir, `${image.view}_comparison.png`);
    const copiedEdited = await copyIfExists(reusable.editedPath, editedTarget);
    const copiedComparison = await copyIfExists(reusable.comparisonPath, comparisonTarget);

    if (copiedEdited && copiedComparison) {
      reused.push({
        sourceView,
        fromTencentView: reusable.projectView,
        targetView: image.view,
      });
    } else {
      missing.push(image.view);
    }
  }

  if (reused.length) {
    appendBatchLog(
      batchJob,
      `[${sourceFolder}] ${modelProvider} reused edited images from Tencent: ${
        reused.map((item) => `${item.sourceView}:${item.fromTencentView}->${item.targetView}`).join(', ')
      }`,
    );
  }
  if (missing.length) {
    appendBatchLog(
      batchJob,
      `[${sourceFolder}] ${modelProvider} still needs OpenAI edits for: ${missing.join(', ')}`,
    );
  }

  await updateManifest(targetProjectDir, {
    reusedEditedFromTencent: reused,
    pendingOpenAiEditsAfterReuse: missing,
  });

  return { reused, missing };
}

async function saveBatchProjectImages(sourceDir, inputPhotosDir, modelProvider) {
  const allowedViews = batchAllowedViews(modelProvider);
  const { byView, ignoredFiles, duplicateFiles } = await scanViewImages(sourceDir, allowedViews);

  for (const field of REQUIRED_FIELDS) {
    if (!byView.has(field)) {
      throw new Error(`Missing required ${field} image in ${path.basename(sourceDir)}.`);
    }
  }

  const selectedImages = selectionFromViewMap(byView, VIEW_FIELDS);
  const saved = await saveSelectedProjectImages(selectedImages, inputPhotosDir);

  return { saved, ignoredFiles, duplicateFiles };
}

function pythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  if (fsSync.existsSync(DEFAULT_PYTHON_BIN)) return DEFAULT_PYTHON_BIN;
  return 'python3';
}

function orthophotoPythonBin() {
  if (process.env.ORTHOPHOTO_PYTHON_BIN) return process.env.ORTHOPHOTO_PYTHON_BIN;
  if (fsSync.existsSync(DEFAULT_ORTHOPHOTO_PYTHON_BIN)) return DEFAULT_ORTHOPHOTO_PYTHON_BIN;
  return pythonBin();
}

function appendJobLog(job, chunk) {
  const text = chunk.toString();
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const entry = `[${new Date().toISOString()}] ${line}`;
    job.logs.push(entry);
    if (job.logs.length > 500) job.logs.shift();
    console.log(`[${job.projectName}] ${line}`);
  }
  fsSync.appendFileSync(job.logPath, text);
}

function appendBatchLog(batchJob, message) {
  const text = String(message);
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const entry = `[${new Date().toISOString()}] ${line}`;
    batchJob.logs.push(entry);
    if (batchJob.logs.length > 700) batchJob.logs.shift();
    console.log(`[${batchJob.batchId}] ${line}`);
  }
  if (batchJob.logPath) {
    fsSync.appendFileSync(batchJob.logPath, lines.map((line) => `${line}\n`).join(''));
  }
}

async function updateManifest(projectDir, patch) {
  const manifestPath = path.join(projectDir, 'project_manifest.json');
  let manifest = {};
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, ...patch }, null, 2));
}

function normalizeProjectTitle(value) {
  return String(value ?? '').trim().slice(0, 180);
}

function normalizeProjectComments(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').slice(0, 5000);
}

async function readProjectManifest(projectName) {
  if (!validProjectName(projectName)) {
    throw new Error('Invalid project name.');
  }
  const manifestPath = path.join(PROJECTS_DIR, projectName, 'project_manifest.json');
  return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function projectTitleForProject(projectName) {
  try {
    const manifest = await readProjectManifest(projectName);
    return normalizeProjectTitle(manifest.projectTitle ?? manifest.project_title ?? '');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function startPipeline(projectName, projectDir, modelProvider = 'tencent') {
  const logsDir = path.join(projectDir, 'logs');
  fsSync.mkdirSync(logsDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const safeTimestamp = startedAt.replace(/[:.]/g, '-');
  const logPath = path.join(logsDir, `node_pipeline_${safeTimestamp}.log`);
  const bin = pythonBin();
  const args = [PYTHON_SERVICE, '--project', projectDir, '--model-provider', modelProvider];

  const job = {
    projectName,
    projectDir,
    status: 'running',
    startedAt,
    finishedAt: null,
    exitCode: null,
    logPath,
    logs: [],
    command: `${bin} ${args.join(' ')}`,
    modelProvider,
  };
  jobs.set(projectName, job);

  console.log(`[${projectName}] Starting pipeline: ${job.command}`);
  fsSync.writeFileSync(logPath, `Command: ${job.command}\nStarted: ${startedAt}\n\n`);

  const child = spawn(bin, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });

  job.pid = child.pid;
  updateManifest(projectDir, {
    pipelineStatus: 'running',
    pipelineStartedAt: startedAt,
    pipelineLogPath: logPath,
    pipelineCommand: job.command,
    modelProvider,
  }).catch((error) => console.error(error));

  child.stdout.on('data', (chunk) => appendJobLog(job, chunk));
  child.stderr.on('data', (chunk) => appendJobLog(job, chunk));
  child.on('error', (error) => {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.error = error.message;
    appendJobLog(job, `Pipeline process error: ${error.message}\n`);
  });
  child.on('close', (code) => {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.status = code === 0 ? 'completed' : 'failed';
    appendJobLog(job, `Pipeline finished with exit code ${code}\n`);
    updateManifest(projectDir, {
      pipelineStatus: job.status,
      pipelineFinishedAt: job.finishedAt,
      pipelineExitCode: code,
    }).catch((error) => console.error(error));
  });

  return job;
}

function runPipelineAndWait(projectName, projectDir, modelProvider, batchJob) {
  return new Promise((resolve) => {
    const logsDir = path.join(projectDir, 'logs');
    fsSync.mkdirSync(logsDir, { recursive: true });
    const startedAt = new Date().toISOString();
    const safeTimestamp = startedAt.replace(/[:.]/g, '-');
    const logPath = path.join(logsDir, `node_pipeline_${safeTimestamp}.log`);
    const bin = pythonBin();
    const args = [PYTHON_SERVICE, '--project', projectDir, '--model-provider', modelProvider];

    const job = {
      projectName,
      projectDir,
      status: 'running',
      startedAt,
      finishedAt: null,
      exitCode: null,
      logPath,
      logs: [],
      command: `${bin} ${args.join(' ')}`,
      modelProvider,
    };
    jobs.set(projectName, job);

    appendBatchLog(batchJob, `[${projectName}] Starting pipeline: ${job.command}`);
    fsSync.writeFileSync(logPath, `Command: ${job.command}\nStarted: ${startedAt}\n\n`);

    const child = spawn(bin, args, {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    job.pid = child.pid;
    updateManifest(projectDir, {
      pipelineStatus: 'running',
      pipelineStartedAt: startedAt,
      pipelineLogPath: logPath,
      pipelineCommand: job.command,
      modelProvider,
    }).catch((error) => console.error(error));

    child.stdout.on('data', (chunk) => {
      appendJobLog(job, chunk);
      appendBatchLog(batchJob, chunk.toString().split(/\r?\n/).filter(Boolean).map((line) => `[${projectName}] ${line}`).join('\n'));
    });
    child.stderr.on('data', (chunk) => {
      appendJobLog(job, chunk);
      appendBatchLog(batchJob, chunk.toString().split(/\r?\n/).filter(Boolean).map((line) => `[${projectName}] ${line}`).join('\n'));
    });
    child.on('error', (error) => {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = error.message;
      appendJobLog(job, `Pipeline process error: ${error.message}\n`);
      appendBatchLog(batchJob, `[${projectName}] Pipeline process error: ${error.message}`);
      resolve(job);
    });
    child.on('close', (code) => {
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      job.status = code === 0 ? 'completed' : 'failed';
      appendJobLog(job, `Pipeline finished with exit code ${code}\n`);
      appendBatchLog(batchJob, `[${projectName}] Pipeline finished with exit code ${code}`);
      updateManifest(projectDir, {
        pipelineStatus: job.status,
        pipelineFinishedAt: job.finishedAt,
        pipelineExitCode: code,
      }).catch((error) => console.error(error));
      resolve(job);
    });
  });
}

function publicJob(job) {
  return {
    projectName: job.projectName,
    projectDir: job.projectDir,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    logPath: job.logPath,
    command: job.command,
    modelProvider: job.modelProvider || null,
    pid: job.pid,
    logs: job.logs.slice(-120),
  };
}

function validProjectName(projectName) {
  return /^project_\d+$/.test(projectName);
}

function validBatchId(batchId) {
  return /^batch_[a-zA-Z0-9_-]+$/.test(batchId);
}

function createBatchId() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `batch_${timestamp}_${randomUUID().slice(0, 8)}`;
}

function publicBatchJob(batchJob) {
  return {
    batchId: batchJob.batchId,
    mode: batchJob.mode || 'configured',
    status: batchJob.status,
    originalName: batchJob.originalName,
    startedAt: batchJob.startedAt,
    finishedAt: batchJob.finishedAt,
    totalSourceFolders: batchJob.totalSourceFolders || null,
    totalProjects: batchJob.projects.length,
    completedProjects: batchJob.projects.filter((project) => project.status === 'completed').length,
    failedProjects: batchJob.projects.filter((project) => project.status === 'failed').length,
    skippedProjects: batchJob.projects.filter((project) => project.status === 'skipped').length,
    runningProject: batchJob.projects.find((project) => project.status === 'running') || null,
    projects: batchJob.projects,
    logs: batchJob.logs.slice(-160),
  };
}

async function validateZipEntries(zipPath) {
  const { stdout } = await execFileAsync('unzip', ['-Z', '-1', zipPath], {
    maxBuffer: 50 * 1024 * 1024,
  });
  const entries = stdout.split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    if (
      normalized.startsWith('/')
      || normalized.includes('/../')
      || normalized.startsWith('../')
      || normalized === '..'
    ) {
      throw new Error(`Unsafe ZIP entry: ${entry}`);
    }
  }
  return entries;
}

async function extractZip(zipPath, outputDir) {
  await ensureDir(outputDir);
  await validateZipEntries(zipPath);
  await execFileAsync('unzip', ['-q', zipPath, '-d', outputDir], {
    maxBuffer: 50 * 1024 * 1024,
  });
}

async function findBatchProjectDirs(rootDir, depth = 0) {
  if (depth > 4) return [];
  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const hasConfig = entries.some((entry) => entry.isFile() && entry.name === 'phone_mapping_project.json');
  if (hasConfig) return [rootDir];

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '__MACOSX') continue;
    results.push(...await findBatchProjectDirs(path.join(rootDir, entry.name), depth + 1));
  }
  return results;
}

async function readBatchProjectConfig(projectDir) {
  const configPath = path.join(projectDir, 'phone_mapping_project.json');
  const payload = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const modelProvider = String(payload.model_provider || '').trim().toLowerCase();
  if (!MODEL_PROVIDERS.has(modelProvider)) {
    throw new Error(`${path.basename(projectDir)} has invalid model_provider. Use "tencent" or "hyper3d".`);
  }
  return {
    modelProvider,
    projectTitle: normalizeProjectTitle(payload.projectTitle ?? payload.project_title ?? ''),
    configPath,
  };
}

async function findImageProjectDirs(rootDir, depth = 0) {
  if (depth > 4) return [];
  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const hasImage = entries.some((entry) => entry.isFile() && imageExtensionFromName(entry.name));
  if (hasImage) return [rootDir];

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '__MACOSX') continue;
    results.push(...await findImageProjectDirs(path.join(rootDir, entry.name), depth + 1));
  }
  return results;
}

function tencentPlanForOrientation(byView, orientation) {
  const allowed = new Set(TENCENT_ALLOWED_VIEWS);
  const selectedByView = new Map();
  const rejected = [];
  const collisions = [];

  for (const view of HYPER3D_SELECTION_ORDER) {
    if (!byView.has(view)) continue;
    const targetView = orientation === 'inverted' ? TENCENT_INVERTED_VIEW[view] : view;
    if (!allowed.has(targetView)) {
      rejected.push({ sourceView: view, targetView });
      continue;
    }
    if (selectedByView.has(targetView)) {
      collisions.push({
        sourceView: view,
        targetView,
        kept: selectedByView.get(targetView).fileName,
        ignored: byView.get(view).fileName,
      });
      continue;
    }
    selectedByView.set(targetView, {
      view: targetView,
      sourceView: view,
      ...byView.get(view),
    });
  }

  const selectedImages = TENCENT_ALLOWED_VIEWS
    .filter((view) => selectedByView.has(view))
    .map((view) => selectedByView.get(view));

  return {
    orientation,
    selectedImages,
    selectedViews: selectedImages.map((image) => image.view),
    sourceViews: selectedImages.map((image) => image.sourceView || image.view),
    rejected,
    collisions,
    hasFront: selectedByView.has('front'),
  };
}

function chooseTencentPlan(byView) {
  const original = tencentPlanForOrientation(byView, 'original');
  const inverted = tencentPlanForOrientation(byView, 'inverted');
  if (inverted.hasFront && !original.hasFront) {
    return { ...inverted, alternative: original, reason: 'inverted orientation is the only option with a front view' };
  }
  if (original.hasFront && !inverted.hasFront) {
    return { ...original, alternative: inverted, reason: 'original orientation is the only option with a front view' };
  }
  if (inverted.selectedImages.length > original.selectedImages.length) {
    return { ...inverted, alternative: original, reason: 'inverted orientation provides more Tencent-compatible views' };
  }
  return { ...original, alternative: inverted, reason: 'original orientation provides equal or more Tencent-compatible views' };
}

function deterministicHyper3dSelection(byView, maxImages = 5) {
  return HYPER3D_SELECTION_ORDER
    .filter((view) => byView.has(view))
    .slice(0, maxImages);
}

function extractOpenAiOutputText(payload) {
  if (typeof payload.output_text === 'string') return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n');
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch (_error) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON object found in OpenAI response.');
    return JSON.parse(match[0]);
  }
}

function normalizeSelectedViews(value, byView) {
  const selected = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const view = normalizeViewToken(item);
    if (!byView.has(view) || seen.has(view)) continue;
    seen.add(view);
    selected.push(view);
  }

  if (byView.has('front') && !seen.has('front')) {
    selected.unshift('front');
  }

  const bounded = selected.slice(0, 5);
  if (bounded.length > 5) bounded.length = 5;
  if (bounded.length === 5 || !byView.has('front') || bounded.includes('front')) return bounded;

  bounded.pop();
  bounded.unshift('front');
  return bounded;
}

async function chooseHyper3dViewsWithOpenAi(sourceDir, byView, batchJob, sourceFolder) {
  const availableViews = HYPER3D_SELECTION_ORDER.filter((view) => byView.has(view));
  if (availableViews.length <= 5) {
    return {
      selectedViews: availableViews,
      method: 'direct',
      reason: 'five or fewer Hyper3D-compatible images were available',
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      selectedViews: deterministicHyper3dSelection(byView),
      method: 'deterministic_fallback',
      reason: 'OPENAI_API_KEY was not available for Hyper3D image selection',
    };
  }

  appendBatchLog(batchJob, `[${sourceFolder}] OpenAI Hyper3D selection started. Candidates: ${availableViews.join(', ')}`);

  const content = [
    {
      type: 'input_text',
      text: [
        'You are selecting the best image views for a Hyper3D Rodin Gen-2.5 residential building reconstruction.',
        'Choose exactly 5 views from the candidate images unless fewer than 5 are provided.',
        'Prioritize: front view included, broad angular coverage around the building, sharpness, low obstructions, visible walls, roof planes, corners, doors/windows, and architectural volumes.',
        'Return only JSON with this schema: {"selected_views":["front","left_front"],"reason":"short reason","view_notes":{"front":"short note"}}.',
        `Candidate view names: ${availableViews.join(', ')}.`,
      ].join(' '),
    },
  ];

  for (const view of availableViews) {
    const image = byView.get(view);
    const buffer = await fs.readFile(image.filePath);
    content.push({ type: 'input_text', text: `Candidate view: ${view}. Original file: ${image.fileName}.` });
    content.push({
      type: 'input_image',
      image_url: `data:${imageMimeFromExtension(image.extension)};base64,${buffer.toString('base64')}`,
    });
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_HYPER3D_SELECTION_MODEL || 'gpt-4.1-mini',
      input: [{ role: 'user', content }],
    }),
  });

  const payload = await response.json().catch(async () => ({ error: await response.text() }));
  if (!response.ok) {
    throw new Error(`OpenAI Hyper3D selection failed: HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  const parsed = parseJsonObject(extractOpenAiOutputText(payload));
  const selectedViews = normalizeSelectedViews(parsed.selected_views, byView);
  if (!selectedViews.length) {
    throw new Error('OpenAI did not return any usable Hyper3D selected_views.');
  }

  return {
    selectedViews,
    method: 'openai',
    reason: parsed.reason || 'OpenAI selected views for Hyper3D coverage and image quality',
    viewNotes: parsed.view_notes || {},
  };
}

async function createInternalProjectFromBatch({ sourceDir, batchJob, config, selectedImages = null, extraManifest = {} }) {
  const projectName = await nextProjectName();
  const projectDir = path.join(PROJECTS_DIR, projectName);
  const folders = await createProjectFolders(projectDir);
  const batchImages = selectedImages
    ? {
        saved: await saveSelectedProjectImages(selectedImages, folders.inputPhotos),
        ignoredFiles: extraManifest.ignoredFiles || [],
        duplicateFiles: extraManifest.duplicateFiles || [],
      }
    : await saveBatchProjectImages(sourceDir, folders.inputPhotos, config.modelProvider);

  const manifest = {
    projectName,
    createdAt: new Date().toISOString(),
    source: 'batch_upload',
    batchId: batchJob.batchId,
    batchSourceFolder: path.basename(sourceDir),
    batchConfigPath: config.configPath || null,
    savedImages: batchImages.saved,
    batchSelectionMapping: selectedImages
      ? selectedImages.map((image) => ({
          sourceView: image.sourceView || image.view,
          projectView: image.view,
          originalFileName: image.fileName,
        }))
      : [],
    ignoredFiles: batchImages.ignoredFiles,
    duplicateFiles: batchImages.duplicateFiles,
    folders,
    modelProvider: config.modelProvider,
    projectTitle: config.projectTitle,
    pipelineStatus: 'uploaded',
    ...extraManifest,
  };
  const manifestPath = path.join(projectDir, 'project_manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    projectName,
    projectDir,
    manifestPath,
    savedImages: batchImages.saved,
    ignoredFiles: batchImages.ignoredFiles,
    duplicateFiles: batchImages.duplicateFiles,
    modelProvider: config.modelProvider,
    projectTitle: config.projectTitle,
    sourceFolder: path.basename(sourceDir),
  };
}

async function processConfiguredBatchJob(batchJob) {
  try {
    batchJob.status = 'running';
    appendBatchLog(batchJob, `Batch started: ${batchJob.originalName}`);

    await extractZip(batchJob.zipPath, batchJob.extractDir);
    appendBatchLog(batchJob, `ZIP extracted to ${batchJob.extractDir}`);

    const sourceProjectDirs = await findBatchProjectDirs(batchJob.extractDir);
    if (!sourceProjectDirs.length) {
      throw new Error('No subfolders with phone_mapping_project.json were found in the ZIP.');
    }

    appendBatchLog(batchJob, `Projects found in ZIP: ${sourceProjectDirs.length}`);

    for (const sourceDir of sourceProjectDirs) {
      const sourceFolder = path.basename(sourceDir);
      const projectRecord = {
        sourceFolder,
        projectName: null,
        modelProvider: null,
        status: 'queued',
        error: null,
      };
      batchJob.projects.push(projectRecord);

      try {
        const config = await readBatchProjectConfig(sourceDir);
        const internalProject = await createInternalProjectFromBatch({ sourceDir, batchJob, config });
        Object.assign(projectRecord, {
          projectName: internalProject.projectName,
          modelProvider: internalProject.modelProvider,
          projectTitle: internalProject.projectTitle,
          savedImages: internalProject.savedImages.length,
          ignoredFiles: internalProject.ignoredFiles,
          status: 'running',
        });

        appendBatchLog(
          batchJob,
          `[${internalProject.projectName}] Created from ${sourceFolder} using ${internalProject.modelProvider}. Images: ${internalProject.savedImages.length}.`,
        );
        const pipelineJob = await runPipelineAndWait(
          internalProject.projectName,
          internalProject.projectDir,
          internalProject.modelProvider,
          batchJob,
        );
        projectRecord.status = pipelineJob.status;
        projectRecord.exitCode = pipelineJob.exitCode;
        projectRecord.finishedAt = pipelineJob.finishedAt;
      } catch (error) {
        projectRecord.status = 'failed';
        projectRecord.error = error.message;
        appendBatchLog(batchJob, `[${sourceFolder}] Failed: ${error.message}`);
      }
    }

    batchJob.finishedAt = new Date().toISOString();
    batchJob.status = batchJob.projects.some((project) => project.status === 'failed')
      ? 'completed_with_errors'
      : 'completed';
    appendBatchLog(batchJob, `Batch finished with status: ${batchJob.status}`);
  } catch (error) {
    batchJob.status = 'failed';
    batchJob.finishedAt = new Date().toISOString();
    batchJob.error = error.message;
    appendBatchLog(batchJob, `Batch failed: ${error.message}`);
  }
}

function providerProjectRecord({ sourceFolder, sourceIndex, sourceTotal, modelProvider }) {
  return {
    sourceFolder,
    sourceIndex,
    sourceTotal,
    projectName: null,
    projectTitle: sourceFolder,
    modelProvider,
    status: 'queued',
    error: null,
  };
}

function logDetectedImages(batchJob, sourceFolder, scan) {
  const found = HYPER3D_SELECTION_ORDER
    .filter((view) => scan.byView.has(view))
    .map((view) => `${view}:${scan.byView.get(view).fileName}`);
  appendBatchLog(batchJob, `[${sourceFolder}] Detecting images. Found: ${found.length ? found.join(', ') : '(none)'}`);
  if (scan.duplicateFiles.length) {
    appendBatchLog(
      batchJob,
      `[${sourceFolder}] Duplicate view files ignored: ${
        scan.duplicateFiles.map((item) => `${item.view} kept ${item.kept}, ignored ${item.ignored}`).join('; ')
      }`,
    );
  }
  if (scan.ignoredFiles.length) {
    appendBatchLog(batchJob, `[${sourceFolder}] Ignored files: ${scan.ignoredFiles.join(', ')}`);
  }
}

async function runBatchProviderAttempt({
  batchJob,
  sourceDir,
  sourceFolder,
  sourceIndex,
  sourceTotal,
  modelProvider,
  selectedImages,
  extraManifest,
  editedReuseMap = null,
}) {
  const projectRecord = providerProjectRecord({ sourceFolder, sourceIndex, sourceTotal, modelProvider });
  batchJob.projects.push(projectRecord);

  try {
    if (!selectedImages.length) {
      throw new Error(`No ${modelProvider} images were selected.`);
    }
    if (!selectedImages.some((image) => image.view === 'front')) {
      throw new Error(`Missing required front image after ${modelProvider} selection.`);
    }

    Object.assign(projectRecord, {
      status: 'setup',
      selectedViews: selectedImages.map((image) => image.view),
      selectedSourceViews: selectedImages.map((image) => image.sourceView || image.view),
    });

    appendBatchLog(
      batchJob,
      `[${sourceFolder}] ${sourceIndex}/${sourceTotal} ${modelProvider} selected views: ${
        selectedImages.map((image) => `${image.sourceView || image.view}->${image.view}`).join(', ')
      }`,
    );

    const internalProject = await createInternalProjectFromBatch({
      sourceDir,
      batchJob,
      config: {
        modelProvider,
        projectTitle: sourceFolder,
        configPath: null,
      },
      selectedImages,
      extraManifest: {
        ...extraManifest,
        source: 'batch_two_models',
        batchMode: 'two_models',
        batchSourceIndex: sourceIndex,
        batchSourceTotal: sourceTotal,
      },
    });

    let reuseResult = null;
    if (editedReuseMap) {
      reuseResult = await reuseEditedOutputsForProject({
        targetProjectDir: internalProject.projectDir,
        selectedImages,
        reuseMap: editedReuseMap,
        batchJob,
        sourceFolder,
        modelProvider,
      });
      projectRecord.reusedEditedImages = reuseResult.reused.length;
      projectRecord.pendingOpenAiEdits = reuseResult.missing.length;
    }

    Object.assign(projectRecord, {
      projectName: internalProject.projectName,
      projectTitle: internalProject.projectTitle,
      savedImages: internalProject.savedImages.length,
      ignoredFiles: internalProject.ignoredFiles,
      status: 'running',
    });

    appendBatchLog(
      batchJob,
      `[${internalProject.projectName}] Created from ${sourceFolder} using ${modelProvider}. Images: ${internalProject.savedImages.length}.`,
    );

    const pipelineJob = await runPipelineAndWait(
      internalProject.projectName,
      internalProject.projectDir,
      modelProvider,
      batchJob,
    );
    projectRecord.status = pipelineJob.status;
    projectRecord.exitCode = pipelineJob.exitCode;
    projectRecord.finishedAt = pipelineJob.finishedAt;
    return {
      projectRecord,
      internalProject,
      pipelineJob,
      selectedImages,
      reuseResult,
    };
  } catch (error) {
    projectRecord.status = 'failed';
    projectRecord.error = error.message;
    appendBatchLog(batchJob, `[${sourceFolder}] ${modelProvider} failed: ${error.message}`);
    return {
      projectRecord,
      internalProject: null,
      pipelineJob: null,
      selectedImages,
      error,
    };
  }
}

async function processBatchTwoModelsJob(batchJob) {
  try {
    batchJob.status = 'running';
    appendBatchLog(batchJob, `Batch two-models started: ${batchJob.originalName}`);

    await extractZip(batchJob.zipPath, batchJob.extractDir);
    appendBatchLog(batchJob, `ZIP extracted to ${batchJob.extractDir}`);

    const sourceProjectDirs = await findImageProjectDirs(batchJob.extractDir);
    if (!sourceProjectDirs.length) {
      throw new Error('No subfolders with directly named image files were found in the ZIP.');
    }

    batchJob.totalSourceFolders = sourceProjectDirs.length;
    appendBatchLog(batchJob, `Source folders found in ZIP: ${sourceProjectDirs.length}`);

    for (const [index, sourceDir] of sourceProjectDirs.entries()) {
      const sourceIndex = index + 1;
      const sourceTotal = sourceProjectDirs.length;
      const sourceFolder = path.basename(sourceDir);
      appendBatchLog(batchJob, `[${sourceFolder}] Batch item ${sourceIndex}/${sourceTotal} setup started.`);

      const scan = await scanViewImages(sourceDir, VIEW_FIELDS);
      logDetectedImages(batchJob, sourceFolder, scan);

      const tencentPlan = chooseTencentPlan(scan.byView);
      let tencentRun = null;
      let tencentEditedReuseMap = null;
      appendBatchLog(
        batchJob,
        `[${sourceFolder}] Tencent orientation check: original=${tencentPlan.alternative.orientation === 'original' ? tencentPlan.alternative.selectedImages.length : tencentPlan.selectedImages.length}, inverted=${tencentPlan.alternative.orientation === 'inverted' ? tencentPlan.alternative.selectedImages.length : tencentPlan.selectedImages.length}. Chosen=${tencentPlan.orientation}. Reason=${tencentPlan.reason}.`,
      );
      if (tencentPlan.hasFront && tencentPlan.selectedImages.length) {
        tencentRun = await runBatchProviderAttempt({
          batchJob,
          sourceDir,
          sourceFolder,
          sourceIndex,
          sourceTotal,
          modelProvider: 'tencent',
          selectedImages: tencentPlan.selectedImages,
          extraManifest: {
            tencentOrientation: tencentPlan.orientation,
            tencentOrientationReason: tencentPlan.reason,
            tencentSourceViews: tencentPlan.sourceViews,
            tencentSelectedViews: tencentPlan.selectedViews,
            tencentAlternative: {
              orientation: tencentPlan.alternative.orientation,
              selectedViews: tencentPlan.alternative.selectedViews,
              sourceViews: tencentPlan.alternative.sourceViews,
            },
            sourceIgnoredFiles: scan.ignoredFiles,
            sourceDuplicateFiles: scan.duplicateFiles,
          },
        });
        if (tencentRun.internalProject && tencentRun.pipelineJob?.status === 'completed') {
          tencentEditedReuseMap = await buildEditedReuseMap(
            tencentRun.internalProject.projectDir,
            tencentRun.selectedImages,
          );
          appendBatchLog(
            batchJob,
            `[${sourceFolder}] Tencent edited reuse map ready: ${tencentEditedReuseMap.size} image pair(s).`,
          );
        } else {
          appendBatchLog(
            batchJob,
            `[${sourceFolder}] Tencent edited reuse map unavailable because Tencent did not complete successfully.`,
          );
        }
      } else {
        const skipped = providerProjectRecord({
          sourceFolder,
          sourceIndex,
          sourceTotal,
          modelProvider: 'tencent',
        });
        skipped.status = 'skipped';
        skipped.error = 'No Tencent-compatible orientation included a front view.';
        batchJob.projects.push(skipped);
        appendBatchLog(batchJob, `[${sourceFolder}] Tencent skipped: ${skipped.error}`);
      }

      try {
        const hyperSelection = await chooseHyper3dViewsWithOpenAi(sourceDir, scan.byView, batchJob, sourceFolder);
        const hyperImages = selectionFromViewMap(scan.byView, hyperSelection.selectedViews);
        appendBatchLog(
          batchJob,
          `[${sourceFolder}] Hyper3D selection method=${hyperSelection.method}. Selected=${hyperSelection.selectedViews.join(', ')}. Reason=${hyperSelection.reason}`,
        );
        if (hyperImages.some((image) => image.view === 'front')) {
          await runBatchProviderAttempt({
            batchJob,
            sourceDir,
            sourceFolder,
            sourceIndex,
            sourceTotal,
            modelProvider: 'hyper3d',
            selectedImages: hyperImages,
            editedReuseMap: tencentEditedReuseMap,
            extraManifest: {
              hyper3dSelectionMethod: hyperSelection.method,
              hyper3dSelectionReason: hyperSelection.reason,
              hyper3dSelectedViews: hyperSelection.selectedViews,
              hyper3dViewNotes: hyperSelection.viewNotes || {},
              sourceIgnoredFiles: scan.ignoredFiles,
              sourceDuplicateFiles: scan.duplicateFiles,
            },
          });
        } else {
          const skipped = providerProjectRecord({
            sourceFolder,
            sourceIndex,
            sourceTotal,
            modelProvider: 'hyper3d',
          });
          skipped.status = 'skipped';
          skipped.error = 'No front view was available for Hyper3D.';
          batchJob.projects.push(skipped);
          appendBatchLog(batchJob, `[${sourceFolder}] Hyper3D skipped: ${skipped.error}`);
        }
      } catch (error) {
        const failed = providerProjectRecord({
          sourceFolder,
          sourceIndex,
          sourceTotal,
          modelProvider: 'hyper3d',
        });
        failed.status = 'failed';
        failed.error = error.message;
        batchJob.projects.push(failed);
        appendBatchLog(batchJob, `[${sourceFolder}] Hyper3D selection failed: ${error.message}`);
      }
    }

    batchJob.finishedAt = new Date().toISOString();
    const failedCount = batchJob.projects.filter((project) => project.status === 'failed').length;
    const completedCount = batchJob.projects.filter((project) => project.status === 'completed').length;
    batchJob.status = failedCount ? 'completed_with_errors' : 'completed';
    appendBatchLog(
      batchJob,
      `Batch finished with status: ${batchJob.status}. Completed provider runs: ${completedCount}. Failed provider runs: ${failedCount}.`,
    );
  } catch (error) {
    batchJob.status = 'failed';
    batchJob.finishedAt = new Date().toISOString();
    batchJob.error = error.message;
    appendBatchLog(batchJob, `Batch failed: ${error.message}`);
  }
}

async function processBatchJob(batchJob) {
  if (batchJob.mode === 'two_models') {
    await processBatchTwoModelsJob(batchJob);
    return;
  }
  await processConfiguredBatchJob(batchJob);
}

function orthophotoDirForProject(projectName) {
  return path.join(PROJECTS_DIR, projectName, 'output_photos', 'orthophotos');
}

function measurementsDirForProject(projectName) {
  return path.join(PROJECTS_DIR, projectName, 'measurements');
}

function comparisonDirForProject(projectName) {
  return path.join(PROJECTS_DIR, projectName, 'output_photos', 'comparison');
}

function topAreaPathForProject(projectName) {
  return path.join(measurementsDirForProject(projectName), 'top_visible_area.json');
}

async function orthophotoFilesForProject(projectName) {
  const outputDir = orthophotoDirForProject(projectName);
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    return entries
      .filter((entry) => {
        const name = entry.name.toLowerCase();
        return entry.isFile()
          && name.endsWith('.png')
          && !name.includes('human_scale')
          && !name.includes('reference_scale');
      })
      .map((entry) => ({
        fileName: entry.name,
        url: `/api/projects/${encodeURIComponent(projectName)}/orthophotos/files/${encodeURIComponent(entry.name)}`,
      }))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function comparisonFilesForProject(projectName) {
  const outputDir = comparisonDirForProject(projectName);
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    return entries
      .filter((entry) => {
        const name = entry.name.toLowerCase();
        return entry.isFile() && /\.(png|jpe?g|webp)$/.test(name);
      })
      .map((entry) => ({
        fileName: entry.name,
        url: `/api/projects/${encodeURIComponent(projectName)}/comparison/files/${encodeURIComponent(entry.name)}`,
      }))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function referenceScaleFileForProject(projectName) {
  const outputDir = orthophotoDirForProject(projectName);
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    const file = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase() === 'reference_scale.png')
      .map((entry) => ({
        fileName: entry.name,
        url: `/api/projects/${encodeURIComponent(projectName)}/orthophotos/files/${encodeURIComponent(entry.name)}`,
      }))[0];
    return file || null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function referenceScaleMetadataForProject(projectName) {
  const metadataPath = path.join(orthophotoDirForProject(projectName), 'reference_scale_metadata.json');
  try {
    return JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function glbModelDimensionsForProject(projectName) {
  const dimensionsPath = path.join(orthophotoDirForProject(projectName), 'glb_model_dimensions.json');
  try {
    return JSON.parse(await fs.readFile(dimensionsPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function deleteHumanScaleForProject(projectName) {
  const outputDir = orthophotoDirForProject(projectName);
  const outputPath = path.join(outputDir, 'human_scale_front.png');
  const workingInputPath = path.join(outputDir, '.human_scale_front_input.png');
  const metadataPath = path.join(outputDir, 'human_scale_front_metadata.json');
  const referenceOutputPath = path.join(outputDir, 'reference_scale.png');
  const referenceMetadataPath = path.join(outputDir, 'reference_scale_metadata.json');
  await fs.rm(outputPath, { force: true });
  await fs.rm(workingInputPath, { force: true });
  await fs.rm(metadataPath, { force: true });
  await fs.rm(referenceOutputPath, { force: true });
  await fs.rm(referenceMetadataPath, { force: true });
}

function pngSize(buffer) {
  if (
    buffer.length < 24
    || buffer.toString('ascii', 1, 4) !== 'PNG'
    || buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error('Expected PNG image data.');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function orthophotoPngSize(projectName, fileName) {
  const imagePath = path.join(orthophotoDirForProject(projectName), fileName);
  const buffer = await fs.readFile(imagePath);
  return pngSize(buffer);
}

async function findOrthophotoByFace(projectName, face) {
  const files = await orthophotoFilesForProject(projectName);
  return files.find((file) => file.fileName.toLowerCase().endsWith(`_${face}.png`)) || null;
}

async function saveReferenceScaleForProject(projectName, payload) {
  const outputDir = orthophotoDirForProject(projectName);
  await ensureDir(outputDir);

  const sourceFileName = path.basename(String(payload.sourceFileName || ''));
  if (!sourceFileName || sourceFileName !== payload.sourceFileName || !sourceFileName.toLowerCase().endsWith('.png')) {
    throw new Error('Invalid reference image file.');
  }

  const sourcePath = path.join(outputDir, sourceFileName);
  await fs.access(sourcePath);

  const knownMeters = Number(payload.knownMeters);
  const pixelDistance = Number(payload.pixelDistance);
  if (!Number.isFinite(knownMeters) || knownMeters <= 0) {
    throw new Error('Reference length in meters must be greater than zero.');
  }
  if (!Number.isFinite(pixelDistance) || pixelDistance <= 0) {
    throw new Error('Reference pixel distance must be greater than zero.');
  }

  const imageDataUrl = String(payload.annotatedImageDataUrl || '');
  const match = imageDataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error('Annotated image must be a PNG data URL.');
  }

  const imageBuffer = Buffer.from(match[1], 'base64');
  const annotatedSize = pngSize(imageBuffer);
  const pixelsPerMeter = pixelDistance / knownMeters;

  const frontFile = await findOrthophotoByFace(projectName, 'front');
  const rightFile = await findOrthophotoByFace(projectName, 'right');
  const frontSize = frontFile ? await orthophotoPngSize(projectName, frontFile.fileName) : null;
  const rightSize = rightFile ? await orthophotoPngSize(projectName, rightFile.fileName) : null;

  const buildingDimensions = {
    method: 'manual_reference_scale',
    reference_length_m: knownMeters,
    reference_length_px: pixelDistance,
    pixels_per_meter: pixelsPerMeter,
    meters_per_pixel: 1 / pixelsPerMeter,
    front_image_size_px: frontSize ? [frontSize.width, frontSize.height] : null,
    right_image_size_px: rightSize ? [rightSize.width, rightSize.height] : null,
    front_width_m: frontSize ? frontSize.width / pixelsPerMeter : null,
    building_length_m: rightSize ? rightSize.width / pixelsPerMeter : null,
  };

  const metadata = {
    source: 'manual_reference_scale',
    source_image: sourceFileName,
    output_image: 'reference_scale.png',
    known_meters: knownMeters,
    pixel_distance: pixelDistance,
    pixels_per_meter: pixelsPerMeter,
    meters_per_pixel: 1 / pixelsPerMeter,
    line: payload.line || null,
    source_image_size_px: payload.imageSize || null,
    annotated_image_size_px: [annotatedSize.width, annotatedSize.height],
    building_dimensions: buildingDimensions,
    created_at: new Date().toISOString(),
  };

  await fs.writeFile(path.join(outputDir, 'reference_scale.png'), imageBuffer);
  await fs.writeFile(
    path.join(outputDir, 'reference_scale_metadata.json'),
    JSON.stringify(metadata, null, 2),
  );

  return metadata;
}

async function firstGlbPathForProject(projectName) {
  const outputGlbDir = path.join(PROJECTS_DIR, projectName, 'output_glb');
  const entries = await fs.readdir(outputGlbDir, { withFileTypes: true });
  const glbEntry = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.glb'))
    .sort((a, b) => a.name.localeCompare(b.name))[0];

  if (!glbEntry) {
    throw new Error(`No GLB file found for ${projectName}.`);
  }
  return path.join(outputGlbDir, glbEntry.name);
}

async function publicOrthophotoState(projectName) {
  const job = orthophotoJobs.get(projectName);
  const files = await orthophotoFilesForProject(projectName);
  const comparisonFiles = await comparisonFilesForProject(projectName);
  const projectTitle = await projectTitleForProject(projectName);
  const humanScaleJob = humanScaleJobs.get(projectName);
  const referenceScaleFile = await referenceScaleFileForProject(projectName);
  const referenceScaleMetadata = await referenceScaleMetadataForProject(projectName);
  const glbModelDimensions = await glbModelDimensionsForProject(projectName);
  const topAreaJob = topAreaJobs.get(projectName);
  let topArea = null;
  try {
    topArea = JSON.parse(await fs.readFile(topAreaPathForProject(projectName), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    projectName,
    projectTitle,
    exists: files.length > 0,
    expectedCount: 5,
    files,
    comparisonFiles,
    referenceScale: {
      exists: Boolean(referenceScaleFile),
      file: referenceScaleFile,
      metadata: referenceScaleMetadata,
      job: humanScaleJob ? publicJob(humanScaleJob) : null,
    },
    humanScale: {
      exists: Boolean(referenceScaleFile),
      file: referenceScaleFile,
      metadata: referenceScaleMetadata,
      job: humanScaleJob ? publicJob(humanScaleJob) : null,
    },
    glbModelDimensions: {
      exists: Boolean(glbModelDimensions),
      result: glbModelDimensions,
    },
    topArea: {
      exists: Boolean(topArea),
      result: topArea,
      job: topAreaJob ? publicJob(topAreaJob) : null,
    },
    job: job ? publicJob(job) : null,
  };
}

function startOrthophotoPipeline(projectName, projectDir, modelPath) {
  const logsDir = path.join(projectDir, 'logs');
  const outputDir = orthophotoDirForProject(projectName);
  fsSync.mkdirSync(logsDir, { recursive: true });
  fsSync.mkdirSync(outputDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const safeTimestamp = startedAt.replace(/[:.]/g, '-');
  const logPath = path.join(logsDir, `orthophotos_${safeTimestamp}.log`);
  const bin = orthophotoPythonBin();
  const args = [
    ORTHOPHOTO_SERVICE,
    '--model',
    modelPath,
    '--output-dir',
    outputDir,
  ];

  const job = {
    projectName,
    projectDir,
    status: 'running',
    startedAt,
    finishedAt: null,
    exitCode: null,
    logPath,
    logs: [],
    command: `${bin} ${args.join(' ')}`,
  };
  orthophotoJobs.set(projectName, job);

  console.log(`[${projectName}] Starting orthophotos: ${job.command}`);
  fsSync.writeFileSync(logPath, `Command: ${job.command}\nStarted: ${startedAt}\n\n`);

  const child = spawn(bin, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });

  job.pid = child.pid;
  updateManifest(projectDir, {
    orthophotoStatus: 'running',
    orthophotoStartedAt: startedAt,
    orthophotoLogPath: logPath,
    orthophotoCommand: job.command,
    orthophotoOutputDir: outputDir,
  }).catch((error) => console.error(error));

  child.stdout.on('data', (chunk) => appendJobLog(job, chunk));
  child.stderr.on('data', (chunk) => appendJobLog(job, chunk));
  child.on('error', (error) => {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.error = error.message;
    appendJobLog(job, `Orthophoto process error: ${error.message}\n`);
  });
  child.on('close', (code) => {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.status = code === 0 ? 'completed' : 'failed';
    appendJobLog(job, `Orthophoto pipeline finished with exit code ${code}\n`);
    updateManifest(projectDir, {
      orthophotoStatus: job.status,
      orthophotoFinishedAt: job.finishedAt,
      orthophotoExitCode: code,
      orthophotoOutputDir: outputDir,
    }).catch((error) => console.error(error));
  });

  return job;
}

function startHumanScalePipeline(projectName, projectDir) {
  const logsDir = path.join(projectDir, 'logs');
  const outputDir = orthophotoDirForProject(projectName);
  fsSync.mkdirSync(logsDir, { recursive: true });
  fsSync.mkdirSync(outputDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const safeTimestamp = startedAt.replace(/[:.]/g, '-');
  const logPath = path.join(logsDir, `human_scale_${safeTimestamp}.log`);
  const bin = orthophotoPythonBin();
  const args = [
    HUMAN_SCALE_SERVICE,
    '--orthophotos-dir',
    outputDir,
  ];

  const job = {
    projectName,
    projectDir,
    status: 'running',
    startedAt,
    finishedAt: null,
    exitCode: null,
    logPath,
    logs: [],
    command: `${bin} ${args.join(' ')}`,
  };
  humanScaleJobs.set(projectName, job);

  console.log(`[${projectName}] Starting human scale: ${job.command}`);
  fsSync.writeFileSync(logPath, `Command: ${job.command}\nStarted: ${startedAt}\n\n`);

  const child = spawn(bin, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });

  job.pid = child.pid;
  updateManifest(projectDir, {
    humanScaleStatus: 'running',
    humanScaleStartedAt: startedAt,
    humanScaleLogPath: logPath,
    humanScaleCommand: job.command,
    humanScaleOutputDir: outputDir,
  }).catch((error) => console.error(error));

  child.stdout.on('data', (chunk) => appendJobLog(job, chunk));
  child.stderr.on('data', (chunk) => appendJobLog(job, chunk));
  child.on('error', (error) => {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.error = error.message;
    appendJobLog(job, `Human scale process error: ${error.message}\n`);
  });
  child.on('close', (code) => {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.status = code === 0 ? 'completed' : 'failed';
    appendJobLog(job, `Human scale pipeline finished with exit code ${code}\n`);
    updateManifest(projectDir, {
      humanScaleStatus: job.status,
      humanScaleFinishedAt: job.finishedAt,
      humanScaleExitCode: code,
      humanScaleOutputDir: outputDir,
    }).catch((error) => console.error(error));
  });

  return job;
}

function startTopAreaPipeline(projectName, projectDir, modelPath) {
  const logsDir = path.join(projectDir, 'logs');
  const outputDir = measurementsDirForProject(projectName);
  const outputPath = topAreaPathForProject(projectName);
  fsSync.mkdirSync(logsDir, { recursive: true });
  fsSync.mkdirSync(outputDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const safeTimestamp = startedAt.replace(/[:.]/g, '-');
  const logPath = path.join(logsDir, `top_area_${safeTimestamp}.log`);
  const bin = orthophotoPythonBin();
  const args = [
    TOP_AREA_SERVICE,
    '--model',
    modelPath,
    '--output',
    outputPath,
  ];

  const job = {
    projectName,
    projectDir,
    status: 'running',
    startedAt,
    finishedAt: null,
    exitCode: null,
    logPath,
    logs: [],
    command: `${bin} ${args.join(' ')}`,
  };
  topAreaJobs.set(projectName, job);

  console.log(`[${projectName}] Starting top area estimation: ${job.command}`);
  fsSync.writeFileSync(logPath, `Command: ${job.command}\nStarted: ${startedAt}\n\n`);

  const child = spawn(bin, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });

  job.pid = child.pid;
  updateManifest(projectDir, {
    topAreaStatus: 'running',
    topAreaStartedAt: startedAt,
    topAreaLogPath: logPath,
    topAreaCommand: job.command,
    topAreaOutputPath: outputPath,
  }).catch((error) => console.error(error));

  child.stdout.on('data', (chunk) => appendJobLog(job, chunk));
  child.stderr.on('data', (chunk) => appendJobLog(job, chunk));
  child.on('error', (error) => {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.error = error.message;
    appendJobLog(job, `Top area process error: ${error.message}\n`);
  });
  child.on('close', (code) => {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.status = code === 0 ? 'completed' : 'failed';
    appendJobLog(job, `Top area pipeline finished with exit code ${code}\n`);
    updateManifest(projectDir, {
      topAreaStatus: job.status,
      topAreaFinishedAt: job.finishedAt,
      topAreaExitCode: code,
      topAreaOutputPath: outputPath,
    }).catch((error) => console.error(error));
  });

  return job;
}

async function glbFilesForProject(projectName) {
  const outputGlbDir = path.join(PROJECTS_DIR, projectName, 'output_glb');
  try {
    const entries = await fs.readdir(outputGlbDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.glb'))
      .map((entry) => ({
        fileName: entry.name,
        url: `/api/projects/${encodeURIComponent(projectName)}/glb/${encodeURIComponent(entry.name)}`,
      }))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function frontPreviewForProject(projectName) {
  const inputPhotosDir = path.join(PROJECTS_DIR, projectName, 'input_photos');
  try {
    const entries = await fs.readdir(inputPhotosDir, { withFileTypes: true });
    const frontImage = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .find((fileName) => /^front\.(jpe?g|png|webp)$/i.test(fileName));

    if (!frontImage) return null;
    return {
      fileName: frontImage,
      url: `/projects/${encodeURIComponent(projectName)}/input_photos/${encodeURIComponent(frontImage)}`,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'phone_mapping_webapp_v1',
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    has3dAiStudioKey: Boolean(process.env['3DAISTUDIO_API_KEY']),
    hasHyper3dKey: Boolean(process.env.HYPER3D_API_KEY),
  });
});

app.get('/api/projects', async (_req, res, next) => {
  try {
    await ensureDir(PROJECTS_DIR);
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    const projectNames = entries
      .filter((entry) => entry.isDirectory() && /^project_\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));

    const projects = await Promise.all(
      projectNames.map(async (projectName) => {
        const manifest = await readProjectManifest(projectName);
        return {
          name: projectName,
          projectTitle: normalizeProjectTitle(manifest.projectTitle ?? manifest.project_title ?? ''),
          modelProvider: manifest.modelProvider || null,
          frontPreview: await frontPreviewForProject(projectName),
          glbFiles: await glbFilesForProject(projectName),
        };
      }),
    );

    res.json({ projects });
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/comments/export', async (_req, res, next) => {
  try {
    await ensureDir(PROJECTS_DIR);
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    const projectNames = entries
      .filter((entry) => entry.isDirectory() && /^project_\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));

    const projects = await Promise.all(
      projectNames.map(async (projectName) => {
        const projectDir = path.join(PROJECTS_DIR, projectName);
        const manifest = await readProjectManifest(projectName);
        const glbFiles = await glbFilesForProject(projectName);
        const referenceScale = await readOptionalJson(
          path.join(projectDir, 'output_photos', 'orthophotos', 'reference_scale_metadata.json'),
        );
        const topVisibleArea = await readOptionalJson(
          path.join(projectDir, 'measurements', 'top_visible_area.json'),
        );
        const glbDimensions = await readOptionalJson(
          path.join(projectDir, 'output_photos', 'orthophotos', 'glb_model_dimensions.json'),
        );

        const buildingDimensions = referenceScale?.building_dimensions || null;
        const metersPerModelUnit = buildingDimensions && glbDimensions?.width_units
          ? buildingDimensions.front_width_m / glbDimensions.width_units
          : null;

        return {
          projectName,
          projectTitle: normalizeProjectTitle(manifest.projectTitle ?? manifest.project_title ?? ''),
          modelProvider: manifest.modelProvider || null,
          projectComments: normalizeProjectComments(manifest.projectComments ?? manifest.project_comments ?? ''),
          projectCommentsUpdatedAt: manifest.projectCommentsUpdatedAt || null,
          pipelineStatus: manifest.pipelineStatus || null,
          createdAt: manifest.createdAt || null,
          pipelineStartedAt: manifest.pipelineStartedAt || null,
          pipelineFinishedAt: manifest.pipelineFinishedAt || null,
          pipelineExitCode: manifest.pipelineExitCode ?? null,
          source: manifest.source || null,
          batchId: manifest.batchId || null,
          batchSourceFolder: manifest.batchSourceFolder || null,
          glbFiles: glbFiles.map((file) => file.fileName),
          referenceScale: referenceScale
            ? {
                sourceImage: referenceScale.source_image || null,
                knownMeters: referenceScale.known_meters ?? null,
                pixelDistance: referenceScale.pixel_distance ?? null,
                pixelsPerMeter: referenceScale.pixels_per_meter ?? null,
                createdAt: referenceScale.created_at || null,
              }
            : null,
          estimatedBuildingDimensions: buildingDimensions
            ? {
                frontWidthMeters: buildingDimensions.front_width_m ?? null,
                buildingLengthMeters: buildingDimensions.building_length_m ?? null,
                estimatedAreaSquareMeters:
                  buildingDimensions.front_width_m && buildingDimensions.building_length_m
                    ? buildingDimensions.front_width_m * buildingDimensions.building_length_m
                    : null,
              }
            : null,
          topVisibleAreaEstimate: topVisibleArea
            ? {
                areaModelUnitsSquared: topVisibleArea.area_units_squared ?? null,
                projectedAreaModelUnitsSquared: topVisibleArea.projected_area_units_squared ?? null,
                visibleFaces: topVisibleArea.mesh?.visible_faces ?? null,
                areaSquareMeters: metersPerModelUnit
                  ? topVisibleArea.area_units_squared * metersPerModelUnit * metersPerModelUnit
                  : null,
                projectedAreaSquareMeters: metersPerModelUnit
                  ? topVisibleArea.projected_area_units_squared * metersPerModelUnit * metersPerModelUnit
                  : null,
              }
            : null,
        };
      }),
    );

    const projectsWithComments = projects.filter((project) => project.projectComments.trim());
    const payload = {
      exportedAt: new Date().toISOString(),
      summary: {
        projectCount: projects.length,
        projectsWithComments: projectsWithComments.length,
      },
      comments: projects.map((project) => ({
        projectName: project.projectName,
        projectTitle: project.projectTitle || 'Untitled',
        modelProvider: project.modelProvider,
        projectComments: project.projectComments,
        projectCommentsUpdatedAt: project.projectCommentsUpdatedAt,
      })),
      projects: projects.map((project) => ({
        projectName: project.projectName,
        projectTitle: project.projectTitle || 'Untitled',
        modelProvider: project.modelProvider,
        pipeline: {
          status: project.pipelineStatus,
          createdAt: project.createdAt,
          startedAt: project.pipelineStartedAt,
          finishedAt: project.pipelineFinishedAt,
          exitCode: project.pipelineExitCode,
          source: project.source,
          batchId: project.batchId,
          batchSourceFolder: project.batchSourceFolder,
        },
        comments: {
          text: project.projectComments,
          updatedAt: project.projectCommentsUpdatedAt,
        },
        outputs: {
          glbFiles: project.glbFiles,
        },
        measurements: {
          referenceScale: project.referenceScale,
          estimatedBuildingDimensions: project.estimatedBuildingDimensions,
          topVisibleAreaEstimate: project.topVisibleAreaEstimate,
        },
      })),
    };

    const datePart = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="phone_mapping_project_comments_${datePart}.json"`);
    res.send(`${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/:projectName', async (req, res, next) => {
  try {
    const { projectName } = req.params;
    if (!validProjectName(projectName)) {
      res.status(400).json({ error: 'Invalid project name.' });
      return;
    }

    const manifest = await readProjectManifest(projectName);
    res.json({
      projectName,
      projectTitle: normalizeProjectTitle(manifest.projectTitle ?? manifest.project_title ?? ''),
      projectComments: normalizeProjectComments(manifest.projectComments ?? manifest.project_comments ?? ''),
      modelProvider: manifest.modelProvider || null,
      pipelineStatus: manifest.pipelineStatus || null,
      createdAt: manifest.createdAt || null,
      glbFiles: await glbFilesForProject(projectName),
    });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/projects/:projectName/title', async (req, res, next) => {
  try {
    const { projectName } = req.params;
    if (!validProjectName(projectName)) {
      res.status(400).json({ error: 'Invalid project name.' });
      return;
    }

    const projectDir = path.join(PROJECTS_DIR, projectName);
    await fs.access(projectDir);
    const projectTitle = normalizeProjectTitle(req.body.projectTitle ?? req.body.project_title ?? '');
    await updateManifest(projectDir, {
      projectTitle,
      projectTitleUpdatedAt: new Date().toISOString(),
    });

    res.json({
      projectName,
      projectTitle,
    });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/projects/:projectName/comments', async (req, res, next) => {
  try {
    const { projectName } = req.params;
    if (!validProjectName(projectName)) {
      res.status(400).json({ error: 'Invalid project name.' });
      return;
    }

    const projectDir = path.join(PROJECTS_DIR, projectName);
    await fs.access(projectDir);
    const projectComments = normalizeProjectComments(req.body.projectComments ?? req.body.project_comments ?? '');
    await updateManifest(projectDir, {
      projectComments,
      projectCommentsUpdatedAt: new Date().toISOString(),
    });

    const manifest = await readProjectManifest(projectName);
    res.json({
      projectName,
      projectTitle: normalizeProjectTitle(manifest.projectTitle ?? manifest.project_title ?? ''),
      projectComments,
      modelProvider: manifest.modelProvider || null,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/:projectName/glb/:fileName', async (req, res, next) => {
  try {
    const { projectName, fileName } = req.params;
    if (!/^project_\d+$/.test(projectName) || path.basename(fileName) !== fileName || !fileName.toLowerCase().endsWith('.glb')) {
      res.status(400).json({ error: 'Invalid GLB request.' });
      return;
    }

    const glbPath = path.join(PROJECTS_DIR, projectName, 'output_glb', fileName);
    await fs.access(glbPath);
    res.download(glbPath, fileName);
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/:projectName/input-photos/:fileName', async (req, res, next) => {
  try {
    const { projectName, fileName } = req.params;
    if (
      !validProjectName(projectName)
      || path.basename(fileName) !== fileName
      || !/\.(png|jpe?g|webp)$/i.test(fileName)
    ) {
      res.status(400).json({ error: 'Invalid input photo request.' });
      return;
    }

    const imagePath = path.join(PROJECTS_DIR, projectName, 'input_photos', fileName);
    await fs.access(imagePath);
    res.sendFile(imagePath);
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/:projectName/status', async (req, res, next) => {
  try {
    const { projectName } = req.params;
    const liveJob = jobs.get(projectName);
    if (liveJob) {
      res.json(publicJob(liveJob));
      return;
    }

    const projectDir = path.join(PROJECTS_DIR, projectName);
    const manifestPath = path.join(projectDir, 'project_manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const manifestStatus = manifest.pipelineStatus || 'unknown';
    const status = manifestStatus === 'running' ? 'interrupted' : manifestStatus;
    const logs = [];
    if (manifest.pipelineLogPath && fsSync.existsSync(manifest.pipelineLogPath)) {
      const logText = fsSync.readFileSync(manifest.pipelineLogPath, 'utf8');
      logs.push(...logText.split(/\r?\n/).filter(Boolean).slice(-120));
    }

    res.json({
      projectName,
      projectTitle: normalizeProjectTitle(manifest.projectTitle ?? manifest.project_title ?? ''),
      projectDir,
      status,
      startedAt: manifest.pipelineStartedAt || null,
      finishedAt: manifest.pipelineFinishedAt || null,
      exitCode: manifest.pipelineExitCode ?? null,
      logPath: manifest.pipelineLogPath || null,
      command: manifest.pipelineCommand || null,
      modelProvider: manifest.modelProvider || null,
      pid: null,
      logs,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/:projectName/orthophotos', async (req, res, next) => {
  try {
    const { projectName } = req.params;
    if (!validProjectName(projectName)) {
      res.status(400).json({ error: 'Invalid project name.' });
      return;
    }

    res.json(await publicOrthophotoState(projectName));
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:projectName/orthophotos', async (req, res, next) => {
  try {
    const { projectName } = req.params;
    if (!validProjectName(projectName)) {
      res.status(400).json({ error: 'Invalid project name.' });
      return;
    }

    const projectDir = path.join(PROJECTS_DIR, projectName);
    await fs.access(projectDir);

    const liveJob = orthophotoJobs.get(projectName);
    if (liveJob && liveJob.status === 'running') {
      res.json(await publicOrthophotoState(projectName));
      return;
    }

    const modelPath = await firstGlbPathForProject(projectName);
    startOrthophotoPipeline(projectName, projectDir, modelPath);
    res.status(202).json(await publicOrthophotoState(projectName));
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/:projectName/orthophotos/status', async (req, res, next) => {
  try {
    const { projectName } = req.params;
    if (!validProjectName(projectName)) {
      res.status(400).json({ error: 'Invalid project name.' });
      return;
    }

    res.json(await publicOrthophotoState(projectName));
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/:projectName/orthophotos/human-scale', async (req, res, next) => {
  try {
    const { projectName } = req.params;
    if (!validProjectName(projectName)) {
      res.status(400).json({ error: 'Invalid project name.' });
      return;
    }

    res.json(await publicOrthophotoState(projectName));
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:projectName/orthophotos/human-scale', async (req, res, next) => {
  try {
    const { projectName } = req.params;
    if (!validProjectName(projectName)) {
      res.status(400).json({ error: 'Invalid project name.' });
      return;
    }

    const projectDir = path.join(PROJECTS_DIR, projectName);
    await fs.access(projectDir);

    const currentState = await publicOrthophotoState(projectName);
    if (!currentState.exists) {
      res.status(400).json({ error: 'Create orthophotos before creating human scale.' });
      return;
    }
    if (currentState.humanScale.exists) {
      res.json(currentState);
      return;
    }

    const liveJob = humanScaleJobs.get(projectName);
    if (liveJob && liveJob.status === 'running') {
      res.json(await publicOrthophotoState(projectName));
      return;
    }

    startHumanScalePipeline(projectName, projectDir);
    res.status(202).json(await publicOrthophotoState(projectName));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/projects/:projectName/orthophotos/human-scale', async (req, res, next) => {
  try {
    const { projectName } = req.params;
    if (!validProjectName(projectName)) {
      res.status(400).json({ error: 'Invalid project name.' });
      return;
    }

    const projectDir = path.join(PROJECTS_DIR, projectName);
    await fs.access(projectDir);

    const liveJob = humanScaleJobs.get(projectName);
    if (liveJob && liveJob.status === 'running') {
      res.status(409).json({ error: 'Human scale generation is still running.' });
      return;
    }

    await deleteHumanScaleForProject(projectName);
    humanScaleJobs.delete(projectName);
    await updateManifest(projectDir, {
      humanScaleStatus: 'deleted',
      humanScaleDeletedAt: new Date().toISOString(),
      humanScaleOutputDir: orthophotoDirForProject(projectName),
    });

    res.json(await publicOrthophotoState(projectName));
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:projectName/orthophotos/reference-scale', async (req, res, next) => {
  try {
    const { projectName } = req.params;
    if (!validProjectName(projectName)) {
      res.status(400).json({ error: 'Invalid project name.' });
      return;
    }

    const projectDir = path.join(PROJECTS_DIR, projectName);
    await fs.access(projectDir);

    const currentState = await publicOrthophotoState(projectName);
    if (!currentState.exists) {
      res.status(400).json({ error: 'Create orthophotos before saving a reference scale.' });
      return;
    }

    await saveReferenceScaleForProject(projectName, req.body || {});
    await updateManifest(projectDir, {
      referenceScaleStatus: 'saved',
      referenceScaleSavedAt: new Date().toISOString(),
      referenceScaleOutputDir: orthophotoDirForProject(projectName),
    });

    res.json(await publicOrthophotoState(projectName));
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:projectName/orthophotos/top-area', async (req, res, next) => {
  try {
    const { projectName } = req.params;
    if (!validProjectName(projectName)) {
      res.status(400).json({ error: 'Invalid project name.' });
      return;
    }

    const projectDir = path.join(PROJECTS_DIR, projectName);
    await fs.access(projectDir);

    const liveJob = topAreaJobs.get(projectName);
    if (liveJob && liveJob.status === 'running') {
      res.json(await publicOrthophotoState(projectName));
      return;
    }

    const modelPath = await firstGlbPathForProject(projectName);
    startTopAreaPipeline(projectName, projectDir, modelPath);
    res.status(202).json(await publicOrthophotoState(projectName));
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/:projectName/orthophotos/files/:fileName', async (req, res, next) => {
  try {
    const { projectName, fileName } = req.params;
    if (
      !validProjectName(projectName)
      || path.basename(fileName) !== fileName
      || !fileName.toLowerCase().endsWith('.png')
    ) {
      res.status(400).json({ error: 'Invalid orthophoto request.' });
      return;
    }

    const imagePath = path.join(orthophotoDirForProject(projectName), fileName);
    await fs.access(imagePath);
    res.sendFile(imagePath);
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/:projectName/comparison/files/:fileName', async (req, res, next) => {
  try {
    const { projectName, fileName } = req.params;
    if (
      !validProjectName(projectName)
      || path.basename(fileName) !== fileName
      || !/\.(png|jpe?g|webp)$/i.test(fileName)
    ) {
      res.status(400).json({ error: 'Invalid comparison image request.' });
      return;
    }

    const imagePath = path.join(comparisonDirForProject(projectName), fileName);
    await fs.access(imagePath);
    res.sendFile(imagePath);
  } catch (error) {
    next(error);
  }
});

app.get('/api/batches/:batchId/status', (req, res) => {
  const { batchId } = req.params;
  if (!validBatchId(batchId)) {
    res.status(400).json({ error: 'Invalid batch id.' });
    return;
  }

  const batchJob = batchJobs.get(batchId);
  if (!batchJob) {
    res.status(404).json({ error: 'Batch not found.' });
    return;
  }

  res.json(publicBatchJob(batchJob));
});

app.post('/api/batches', batchUpload.single('batch_zip'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Upload a .zip file for Batch Production.' });
      return;
    }
    const mode = BATCH_MODES.has(req.body.batch_mode) ? req.body.batch_mode : 'configured';

    const batchId = createBatchId();
    const batchDir = path.join(BATCH_UPLOADS_DIR, batchId);
    const extractDir = path.join(batchDir, 'extracted');
    const logsDir = path.join(batchDir, 'logs');
    await ensureDir(logsDir);

    const zipPath = path.join(batchDir, 'source.zip');
    await fs.writeFile(zipPath, req.file.buffer);

    const startedAt = new Date().toISOString();
    const logPath = path.join(logsDir, `batch_${startedAt.replace(/[:.]/g, '-')}.log`);
    const batchJob = {
      batchId,
      mode,
      originalName: req.file.originalname,
      status: 'queued',
      startedAt,
      finishedAt: null,
      zipPath,
      extractDir,
      logPath,
      projects: [],
      logs: [],
    };
    batchJobs.set(batchId, batchJob);
    fsSync.writeFileSync(logPath, `Batch: ${batchId}\nMode: ${mode}\nSource: ${req.file.originalname}\nStarted: ${startedAt}\n\n`);

    processBatchJob(batchJob).catch((error) => {
      batchJob.status = 'failed';
      batchJob.finishedAt = new Date().toISOString();
      batchJob.error = error.message;
      appendBatchLog(batchJob, `Batch process error: ${error.message}`);
    });

    res.status(202).json(publicBatchJob(batchJob));
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects', upload.any(), async (req, res, next) => {
  try {
    const modelProvider = MODEL_PROVIDERS.has(req.body.model_provider)
      ? req.body.model_provider
      : 'tencent';
    const projectTitle = normalizeProjectTitle(req.body.projectTitle ?? req.body.project_title ?? '');
    const fileMap = filesByField(req.files);
    const missing = validateRequiredUploads(fileMap);
    if (missing.length) {
      res.status(400).json({
        error: 'Missing required image upload.',
        missing,
      });
      return;
    }

    const projectName = await nextProjectName();
    const projectDir = path.join(PROJECTS_DIR, projectName);
    const folders = await createProjectFolders(projectDir);
    const savedImages = await saveUploadedImages(fileMap, folders.inputPhotos);

    const manifest = {
      projectName,
      createdAt: new Date().toISOString(),
      savedImages,
      folders,
      modelProvider,
      projectTitle,
      pipelineStatus: 'uploaded',
    };
    const manifestPath = path.join(projectDir, 'project_manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const job = startPipeline(projectName, projectDir, modelProvider);

    res.status(201).json({
      projectName,
      projectDir,
      manifestPath,
      savedImages,
      modelProvider,
      projectTitle,
      nextStep: 'python_pipeline_running',
      pipeline: publicJob(job),
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    res.status(400).json({
      error: error.message,
      field: error.field,
      code: error.code,
    });
    return;
  }
  res.status(500).json({
    error: error.message || 'Internal server error',
  });
});

app.listen(PORT, () => {
  console.log(`Phone Mapping web app listening on http://localhost:${PORT}`);
});
