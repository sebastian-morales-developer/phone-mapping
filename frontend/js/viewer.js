import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const canvas = document.querySelector('#viewerCanvas');
const loadingPanel = document.querySelector('#loadingPanel');
const title = document.querySelector('#viewerTitle');
const subtitle = document.querySelector('#viewerSubtitle');
const downloadLink = document.querySelector('#downloadLink');

const params = new URLSearchParams(window.location.search);
const modelUrl = params.get('model');
const projectName = params.get('project') || 'Project';

title.textContent = projectName;
downloadLink.href = modelUrl || '#';

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
