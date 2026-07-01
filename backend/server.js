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
const PYTHON_SERVICE = path.join(ROOT_DIR, 'python_services', 'run_extended_pipeline.py');
const ORTHOPHOTO_SERVICE = path.join(ROOT_DIR, 'python_services', 'create_orthophotos.py');
const HUMAN_SCALE_SERVICE = path.join(ROOT_DIR, 'python_services', 'create_human_scale.py');
const TOP_AREA_SERVICE = path.join(ROOT_DIR, 'python_services', 'calculate_top_area.py');
const DEFAULT_PYTHON_BIN = path.join(ROOT_DIR, '.venv', 'bin', 'python');
const DEFAULT_ORTHOPHOTO_PYTHON_BIN = path.join(ROOT_DIR, '.venv', 'bin', 'python');

const VIEW_FIELDS = ['front', 'left', 'right', 'back', 'left_front', 'right_front', 'back_left', 'back_right'];
const REQUIRED_FIELDS = new Set(['front']);
const MODEL_PROVIDERS = new Set(['tencent', 'hyper3d']);
const IMAGE_MIME_TO_EXT = {
  'image/jpeg': '.jpeg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const jobs = new Map();
const orthophotoJobs = new Map();
const humanScaleJobs = new Map();
const topAreaJobs = new Map();

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
app.use(express.json({ limit: '25mb' }));
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

app.post('/api/projects', upload.any(), async (req, res, next) => {
  try {
    const modelProvider = MODEL_PROVIDERS.has(req.body.model_provider)
      ? req.body.model_provider
      : 'tencent';
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
