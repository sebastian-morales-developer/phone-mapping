const cors = require('cors');
const dotenv = require('dotenv');
const express = require('express');
const fs = require('fs/promises');
const fsSync = require('fs');
const morgan = require('morgan');
const multer = require('multer');
const path = require('path');
const { spawn } = require('child_process');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
const PROJECTS_DIR = path.join(ROOT_DIR, 'projects');
const PYTHON_SERVICE = path.join(ROOT_DIR, 'python_services', 'run_pipeline.py');
const DEFAULT_PYTHON_BIN = '/home/usuario/projects/phone_mapping_v1/.venv/bin/python';

const VIEW_FIELDS = ['front', 'left', 'right', 'back', 'left_front', 'right_front'];
const REQUIRED_FIELDS = new Set(['front']);
const IMAGE_MIME_TO_EXT = {
  'image/jpeg': '.jpeg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const jobs = new Map();

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

app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
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

function pythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  if (fsSync.existsSync(DEFAULT_PYTHON_BIN)) return DEFAULT_PYTHON_BIN;
  return 'python3';
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

function startPipeline(projectName, projectDir) {
  const logsDir = path.join(projectDir, 'logs');
  fsSync.mkdirSync(logsDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const safeTimestamp = startedAt.replace(/[:.]/g, '-');
  const logPath = path.join(logsDir, `node_pipeline_${safeTimestamp}.log`);
  const bin = pythonBin();
  const args = [PYTHON_SERVICE, '--project', projectDir];

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
    pid: job.pid,
    logs: job.logs.slice(-120),
  };
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

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'phone_mapping_webapp_v1',
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    has3dAiStudioKey: Boolean(process.env['3DAISTUDIO_API_KEY']),
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
      projectNames.map(async (projectName) => ({
        name: projectName,
        glbFiles: await glbFilesForProject(projectName),
      })),
    );

    res.json({ projects });
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
      projectDir,
      status,
      startedAt: manifest.pipelineStartedAt || null,
      finishedAt: manifest.pipelineFinishedAt || null,
      exitCode: manifest.pipelineExitCode ?? null,
      logPath: manifest.pipelineLogPath || null,
      command: manifest.pipelineCommand || null,
      pid: null,
      logs,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects', upload.any(), async (req, res, next) => {
  try {
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
      pipelineStatus: 'uploaded',
    };
    const manifestPath = path.join(projectDir, 'project_manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const job = startPipeline(projectName, projectDir);

    res.status(201).json({
      projectName,
      projectDir,
      manifestPath,
      savedImages,
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
