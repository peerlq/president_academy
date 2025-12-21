
async function init() {
  const [THREEmod, { GLTFLoader }, { OrbitControls }] = await Promise.all([
    import('https://unpkg.com/three@0.160.0/build/three.module.js'),
    import('https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js'),
    import('https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js')
  ]);
  const THREE = THREEmod;
  const header = document.querySelector('.site-header');
  const host = document.getElementById('canvas-host');
  const resetBtn = document.getElementById('reset-view');
  const floorPanel = document.querySelector('.floor-panel');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  host.appendChild(renderer.domElement);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setClearColor(0x121a2b);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(5, 10, 7);
  scene.add(dir);
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  scene.add(new THREE.GridHelper(20, 20, 0x444444, 0x222222));
  camera.position.set(6, 4, 8);
  camera.lookAt(0, 0, 0);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  let homePos = null;
  const homeTarget = new THREE.Vector3();
  let currentModel = null;

  function size() {
    const w = window.innerWidth;
    const h = Math.max(200, window.innerHeight - header.offsetHeight);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  size();
  window.addEventListener('resize', size);

  const loader = new GLTFLoader();
  function resolveModel(name) {
    try { return new URL(`./models/${name}`, import.meta.url).href; }
    catch (_) { return `./models/${name}`; }
  }
  function pathForFloor(f) {
    if (f === 2) return resolveModel('building2.glb');
    return resolveModel('model.glb');
  }
  function removeCurrent() {
    if (!currentModel) return;
    scene.remove(currentModel);
    currentModel = null;
  }
  function showFloor(floor) {
    removeCurrent();
    loader.load(pathForFloor(floor), g => {
      const m = g.scene;
      m.traverse((o)=>{
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      let box0 = new THREE.Box3().setFromObject(m);
      let size0 = box0.getSize(new THREE.Vector3());
      let r0 = Math.max(size0.x, size0.y, size0.z) * 0.5;
      if (!isFinite(r0) || r0 <= 0) r0 = 1;
      const desiredRadius = 3;
      const scaleFactor = Math.max(0.1, Math.min(50, desiredRadius / r0));
      m.scale.set(scaleFactor, scaleFactor, scaleFactor);
      scene.add(m);
      currentModel = m;
      let box = new THREE.Box3().setFromObject(m);
      let center = box.getCenter(new THREE.Vector3());
      m.position.sub(center);
      box = new THREE.Box3().setFromObject(m);
      center = box.getCenter(new THREE.Vector3());
      let sizeV = box.getSize(new THREE.Vector3());
      let radius = Math.max(sizeV.x, sizeV.y, sizeV.z) * 0.5;
      if (!isFinite(radius) || radius <= 0) radius = 1;
      const fov = camera.fov * (Math.PI / 180);
      let dist = radius / Math.tan(fov / 2);
      dist = dist / 1.25 + 0.8;
      camera.position.copy(center.clone().add(new THREE.Vector3(dist, dist * 0.6, dist)));
      camera.near = Math.max(0.1, dist * 0.01);
      camera.far = dist * 100;
      camera.updateProjectionMatrix();
      camera.lookAt(center);
      controls.target.copy(center);
      controls.update();
      homePos = camera.position.clone();
      homeTarget.copy(center);
      console.log('floor loaded', { floor, size: sizeV, center, scale: scaleFactor });
    }, undefined, (e) => {
      console.error('GLB load error', e);
    });
  }
  showFloor(1);

  if (floorPanel) {
    floorPanel.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.floor-btn');
      if (!btn) return;
      floorPanel.querySelectorAll('.floor-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const f = parseInt(btn.dataset.floor || '1', 10);
      showFloor(f);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (homePos) {
        camera.position.copy(homePos);
        controls.target.copy(homeTarget);
        camera.lookAt(homeTarget);
        controls.update();
      }
    });
  }

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}

init().catch(err => console.error('init error', err));
