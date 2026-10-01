// Step3D — application d'annotation de la marche
// Vue 3D des marqueurs, lecture image par image, pose/lever des pieds en base Supabase.
import * as THREE from 'three';

/* ---------- Accès Supabase (REST, clé publishable) ---------- */
const HDRS = {
  apikey: CONFIG.key,
  Authorization: `Bearer ${CONFIG.key}`,
  'Content-Type': 'application/json',
};
function api(chemin, options = {}) {
  return fetch(`${CONFIG.url}/rest/v1/${chemin}`, { headers: HDRS, ...options })
    .then(async (r) => {
      if (!r.ok) throw new Error(`Supabase : erreur ${r.status}`);
      const texte = await r.text();
      return texte ? JSON.parse(texte) : null;
    });
}

/* ---------- Marqueurs ---------- */
// Chaque marqueur est un point [x, y, z] en mètres, z vertical.
// Un marqueur (0, 0, 0) n'est pas capté : on ne l'affiche pas.
const GAUCHE = ['L_FTC', 'L_FLE', 'L_FAX', 'L_FAL', 'L_TTC', 'L_FCC', 'L_FM1', 'L_FM5'];
const DROIT = ['R_FTC', 'R_FLE', 'R_FAX', 'R_FAL', 'R_TTC', 'R_FCC', 'R_FM1', 'R_FM5'];
const BASSIN = ['L_IAS', 'L_IPS', 'R_IAS', 'R_IPS'];
const TOUS = [...GAUCHE, ...DROIT, ...BASSIN];
const COULEUR = { gauche: 0x4cc3f2, droit: 0xf2913d, bassin: 0x9fb3c8 };

// Segments du petit squelette affiché en plus des points
const SEGMENTS = [
  ['L_IAS', 'R_IAS'], ['R_IAS', 'R_IPS'], ['R_IPS', 'L_IPS'], ['L_IPS', 'L_IAS'],
  ['L_FTC', 'L_FLE'], ['L_FLE', 'L_FAX'], ['L_FAX', 'L_FAL'], ['L_FAL', 'L_FCC'],
  ['L_FCC', 'L_FM1'], ['L_FCC', 'L_FM5'], ['L_FM1', 'L_FM5'],
  ['R_FTC', 'R_FLE'], ['R_FLE', 'R_FAX'], ['R_FAX', 'R_FAL'], ['R_FAL', 'R_FCC'],
  ['R_FCC', 'R_FM1'], ['R_FCC', 'R_FM5'], ['R_FM1', 'R_FM5'],
];
const MARQUEURS_TRAINEES = { gauche: ['L_TTC', 'L_FM1', 'L_FM5'], droit: ['R_TTC', 'R_FM1', 'R_FM5'] };

/* ---------- État ---------- */
let catalogue = [];   // tous les essais (avec sujet, visite, date)
let courant = null;   // essai affiché
let data = null;      // contenu JSON de l'essai
let frame = 0;          // image affichée (entier)
let position = 0;       // position flottante pendant la lecture
let lecture = false;
let vitesse = 1;
let evenements = [];  // { pied, type, image } — image = numéro d'image (0 = première)
let annulePile = [];
let sale = false;     // modifications non enregistrées
let evenementChoisi = null;

const $ = (id) => document.getElementById(id);
const nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

/* ---------- Scène 3D ---------- */
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a101f);
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);

scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x1a2438, 1.1));
const soleil = new THREE.DirectionalLight(0xffffff, 1.4);
soleil.position.set(3, 8, 4);
scene.add(soleil);

// Sol : disque sombre + quadrillage
const sol = new THREE.Mesh(
  new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x101b31, roughness: 1 })
);
const grille = new THREE.GridHelper(2, 10, 0x223457, 0x182642);
scene.add(sol, grille);

// Un point par marqueur
const rayon = 0.028;
const geometriePoint = new THREE.SphereGeometry(rayon, 14, 10);
const points = {};
const groupeDe = (nom) => BASSIN.includes(nom) ? 'bassin' : nom.startsWith('L_') ? 'gauche' : 'droit';
for (const nom of TOUS) {
  const groupe = groupeDe(nom);
  const mat = new THREE.MeshStandardMaterial({ color: COULEUR[groupe], roughness: 0.45 });
  const taille = groupe === 'bassin' ? 1.25 : 1;
  points[nom] = new THREE.Mesh(geometriePoint, mat);
  points[nom].scale.setScalar(taille);
  points[nom].visible = false;
  scene.add(points[nom]);
}

// Squelette : un segment (ligne de 2 points) par paire de marqueurs
const segments = [];
for (const [a, b] of SEGMENTS) {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const couleur = COULEUR[groupeDe(a)];
  const ligne = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: couleur, transparent: true, opacity: 0.55 }));
  ligne.visible = false;
  scene.add(ligne);
  segments.push({ a, b, ligne });
}

// Traces des marqueurs du pied sur tout l'essai
let trainees = null;

// Position dans la scène : les données ont z vertical, la scène a y vertical
function versScene(p) { return new THREE.Vector3(p[0], p[2], -p[1]); }
function capte(p) { return !(p[0] === 0 && p[1] === 0 && p[2] === 0); }

/* ---------- Caméra : souris + Z Q S D ---------- */
let camTarget = new THREE.Vector3(0, 0.8, 0);
let camDist = 4, camTheta = 0, camPhi = 0.5;
const touches = {};

function appliquerCamera() {
  const x = camTarget.x + camDist * Math.cos(camPhi) * Math.sin(camTheta);
  const y = camTarget.y + camDist * Math.sin(camPhi);
  const z = camTarget.z + camDist * Math.cos(camPhi) * Math.cos(camTheta);
  camera.position.set(x, y, z);
  camera.lookAt(camTarget);
}
appliquerCamera();

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
  canvas.dataset.drag = '1';
  canvas.dataset.px = e.clientX;
  canvas.dataset.py = e.clientY;
});
canvas.addEventListener('pointermove', (e) => {
  if (canvas.dataset.drag !== '1') return;
  const dx = e.clientX - canvas.dataset.px, dy = e.clientY - canvas.dataset.py;
  canvas.dataset.px = e.clientX; canvas.dataset.py = e.clientY;
  camTheta -= dx * 0.005;
  camPhi = Math.min(1.5, Math.max(0.08, camPhi + dy * 0.005));
  appliquerCamera();
});
canvas.addEventListener('pointerup', () => { canvas.dataset.drag = '0'; canvas.classList.remove('dragging'); });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camDist = Math.min(200, Math.max(0.4, camDist * Math.exp(e.deltaY * 0.001)));
  appliquerCamera();
}, { passive: false });

function bougerCamera(dt) {
  const z = (touches.KeyW ? 1 : 0) - (touches.KeyS ? 1 : 0); // Z = avancer, S = reculer
  const x = (touches.KeyD ? 1 : 0) - (touches.KeyA ? 1 : 0); // Q = gauche, D = droite
  if (!z && !x) return;
  const pas = camDist * dt * 0.9;
  const avance = new THREE.Vector3(-Math.sin(camTheta), 0, -Math.cos(camTheta));
  const cote = new THREE.Vector3(Math.cos(camTheta), 0, -Math.sin(camTheta));
  camTarget.addScaledVector(avance, z * pas).addScaledVector(cote, x * pas);
  appliquerCamera();
}

/* ---------- Chargement d'un essai ---------- */
async function chargerCatalogue() {
  const [sujets, visites, essais] = await Promise.all([
    api('sujets?select=*&order=nom'),
    api('visites?select=*&order=sujet.asc,numero.asc'),
    api('essais?select=*&order=id'),
  ]);
  catalogue = essais.map((e) => {
    const v = visites.find((x) => x.id === e.visite_id);
    return { ...e, sujet: v.sujet, visite: v.numero, date_visite: v.date_visite };
  });
  catalogue.sort((a, b) => a.sujet.localeCompare(b.sujet) || a.visite - b.visite || a.numero - b.numero);
  dessinerArbre();
}

function dateFr(iso) {
  if (!iso) return '';
  const [a, m, j] = iso.split('-');
  return `${j}/${m}/${a}`;
}

function dessinerArbre() {
  const tree = $('tree');
  tree.innerHTML = '';
  const sujets = [...new Set(catalogue.map((e) => e.sujet))];
  for (const sujet of sujets) {
    const essaisSujet = catalogue.filter((e) => e.sujet === sujet);
    const div = document.createElement('div');
    div.className = 'sujet';
    const nbAnn = essaisSujet.filter((e) => e.annotee).length;
    div.innerHTML = `<div class="sujet-name"><span>${sujet}</span>
      <span class="badge ${nbAnn === essaisSujet.length ? 'ok' : ''}">${essaisSujet.length} essai${essaisSujet.length > 1 ? 's' : ''}</span></div>`;
    const visites = [...new Set(essaisSujet.map((e) => e.visite))].sort((a, b) => a - b);
    for (const nv of visites) {
      const ev = document.createElement('div');
      ev.className = 'visite';
      const d = essaisSujet.find((e) => e.visite === nv).date_visite;
      ev.textContent = `Visite ${nv}${d ? ' · ' + dateFr(d) : ''}`;
      div.appendChild(ev);
      for (const e of essaisSujet.filter((x) => x.visite === nv).sort((a, b) => a.numero - b.numero)) {
        const ligne = document.createElement('div');
        ligne.className = 'essai-row' + (courant && e.id === courant.id ? ' active' : '');
        ligne.innerHTML = `<span>Essai ${e.numero}</span>
          <span class="badge ${e.annotee ? 'ok' : 'todo'}">${e.annotee ? 'annoté' : 'à faire'}</span>`;
        ligne.addEventListener('click', () => chargerEssai(e));
        div.appendChild(ligne);
      }
    }
    tree.appendChild(div);
  }
}

async function chargerEssai(essai) {
  courant = essai;
  lecture = false; majBoutonLecture();
  $('loading').hidden = false;
  dessinerArbre();
  try {
    data = await fetch(`essais/${essai.fichier}`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    const rep = await api(`evenements?essai_id=eq.${essai.id}&order=image.asc,created_at.asc`);
    evenements = rep.map((e) => ({ pied: e.pied, type: e.type, image: e.image }));
    annulePile = [];
    sale = false;
    evenementChoisi = null;
    frame = 0; position = 0;
    construireScene();
    camTarget = new THREE.Vector3(...(limites.cible || limites.centre));
    camDist = limites.distance;
    camTheta = 0; camPhi = 0.5;
    appliquerCamera();
    majTitre();
    majParametres();
    majEvenements();
    majImage(true);
  } catch (err) {
    afficherToast('Impossible de charger cet essai', true);
    console.error(err);
  }
  $('loading').hidden = true;
}

// Étendue des données (pour le sol, la caméra et les traces)
let limites = { centre: [0, 0.8, 0], distance: 4 };

function construireScene() {
  const nb = data.nb_images;
  // Bornes (un point sur 20 suffit)
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let i = 0; i < nb; i += 20) {
    for (const nom of TOUS) {
      const p = data.marqueurs[nom]?.[i];
      if (!p || !capte(p)) continue;
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
  }
  const spanX = maxX - minX, spanY = maxY - minY;
  const span = Math.max(spanX, spanY);
  const rayonSol = Math.max(3, span / 2 + 2);
  sol.scale.setScalar(rayonSol);
  scene.remove(grille);
  grille.scale.setScalar(rayonSol);
  scene.add(grille);
  limites = {
    centre: [(minX + maxX) / 2, 0.9, -(minY + maxY) / 2],
    distance: Math.max(4, span * 0.85),
  };

  // La caméra démarre près du marcheur (centre du corps à l'image 0)
  let cx = 0, cy = 0, cz = 0, n = 0;
  for (const nom of TOUS) {
    const p = data.marqueurs[nom]?.[0];
    if (!p || !capte(p)) continue;
    cx += p[0]; cy += p[2]; cz += -p[1]; n++;
  }
  if (n) {
    limites.cible = [cx / n, cy / n + 0.2, cz / n];
    limites.distance = 3;
  }

  // Traces des pieds
  if (trainees) {
    trainees.forEach((t) => { scene.remove(t); t.geometry.dispose(); });
  }
  trainees = [];
  const pas = 2; // une image sur 2 suffit pour une trace
  for (const pied of ['gauche', 'droit']) {
    for (const nom of MARQUEURS_TRAINEES[pied]) {
      const arr = data.marqueurs[nom];
      if (!arr) continue;
      const pos = [];
      let precedent = arr[0];
      for (let i = pas; i < nb; i += pas) {
        const b = arr[i];
        if (capte(precedent) && capte(b)) {
          pos.push(precedent[0], precedent[2], -precedent[1], b[0], b[2], -b[1]);
        }
        precedent = b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const ligne = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: COULEUR[pied], transparent: true, opacity: 0.28,
      }));
      scene.add(ligne);
      trainees.push(ligne);
    }
  }
}

function majTitre() {
  $('essai-title').textContent = `${courant.sujet} · Visite ${courant.visite} · Essai ${courant.numero}`;
  const duree = nf1.format(data.nb_images / data.frequence_hz);
  $('essai-sub').textContent = `${data.nb_images} images · ${data.frequence_hz} Hz · ${duree} s`;
}

/* ---------- Affichage de l'image courante ---------- */
function majImage(force = false) {
  if (!data) return;
  const nb = data.nb_images;
  for (const nom of TOUS) {
    const p = data.marqueurs[nom]?.[frame];
    const m = points[nom];
    if (!p || !capte(p)) { m.visible = false; continue; }
    m.visible = true;
    m.position.copy(versScene(p));
  }
  for (const { a, b, ligne } of segments) {
    const pa = data.marqueurs[a]?.[frame], pb = data.marqueurs[b]?.[frame];
    if (!pa || !pb || !capte(pa) || !capte(pb)) { ligne.visible = false; continue; }
    ligne.visible = true;
    const pos = ligne.geometry.attributes.position;
    pos.setXYZ(0, pa[0], pa[2], -pa[1]);
    pos.setXYZ(1, pb[0], pb[2], -pb[1]);
    pos.needsUpdate = true;
  }
  // Boîte d'information et pistes
  $('info-ligne1').textContent = `Image ${frame} / ${nb - 1} · ${nf2.format(frame / data.frequence_hz)} s`;
  $('info-pg').textContent = auSol('gauche', frame) ? 'au sol' : 'levé';
  $('info-pd').textContent = auSol('droit', frame) ? 'au sol' : 'levé';
  $('time-label').textContent = `${nf2.format(frame / data.frequence_hz)} s`;
  dessinerPiste($('tl-g'), 'gauche');
  dessinerPiste($('tl-d'), 'droit');
}

// Le pied est-il au sol à l'image f ? (d'après les événements, sinon contact_sol)
function auSol(pied, f) {
  let sol = data.contact_sol ? data.contact_sol[pied]?.[f] === 1 : false;
  const evs = evenements.filter((e) => e.pied === pied).sort((a, b) => a.image - b.image);
  for (const e of evs) {
    if (e.image > f) break;
    sol = e.type === 'pose';
  }
  return sol;
}

/* ---------- Paramètres de l'essai (panneau gauche) ---------- */
function majParametres() {
  const nb = data.nb_images, freq = data.frequence_hz;
  const poses = evenements.filter((e) => e.type === 'pose').length;
  $('p-cadence').textContent = poses ? `${Math.round(poses / (nb / freq) * 60)} pas/min` : '—';

  const appui = (pied) => {
    let images = 0;
    const evs = evenements.filter((e) => e.pied === pied).sort((a, b) => a.image - b.image);
    if (evs.length) {
      for (let k = 0; k < evs.length; k++) {
        if (evs[k].type !== 'pose') continue;
        const lever = evs.find((e, j) => j > k && e.type === 'lever' && e.image >= evs[k].image);
        if (lever) images += lever.image - evs[k].image + 1;
      }
    } else if (data.contact_sol) {
      for (let i = 0; i < nb; i++) if (data.contact_sol[pied][i] === 1) images++;
    } else return null;
    return Math.round(images / nb * 100) + ' %';
  };
  $('p-appui-g').textContent = appui('gauche') ?? '—';
  $('p-appui-d').textContent = appui('droit') ?? '—';
}

/* ---------- Événements (pose / lever) ---------- */
function pousserAnnule() {
  annulePile.push(JSON.stringify(evenements));
  if (annulePile.length > 100) annulePile.shift();
}

function placerEvenement(pied, type) {
  if (!data) return;
  pousserAnnule();
  const deja = evenements.find((e) => e.pied === pied && e.type === type && e.image === frame);
  if (!deja) evenements.push({ pied, type, image: frame });
  marquerSale();
  evenementChoisi = evenements.find((e) => e.pied === pied && e.type === type && e.image === frame) || null;
  majEvenements();
  majImage(true);
}

function deplacerIci(index) {
  pousserAnnule();
  const e = evenements[index];
  e.image = frame;
  // Si un événement identique existe déjà à cette image, on ne garde pas le doublon
  for (let i = evenements.length - 1; i >= 0; i--) {
    const autre = evenements[i];
    if (autre !== e && autre.pied === e.pied && autre.type === e.type && autre.image === frame) {
      evenements.splice(i, 1);
    }
  }
  marquerSale();
  majEvenements();
  majImage(true);
}

function supprimerEvenement(index) {
  pousserAnnule();
  if (evenementChoisi === evenements[index]) evenementChoisi = null;
  evenements.splice(index, 1);
  marquerSale();
  majEvenements();
  majImage(true);
}

function toutEffacer() {
  if (!evenements.length) return;
  pousserAnnule();
  evenements = [];
  evenementChoisi = null;
  marquerSale();
  majEvenements();
  majImage(true);
}

// Détection automatique d'après la détection de contact sol du fichier
function detecterAutomatique() {
  if (!data.contact_sol) return afficherToast('Ce fichier n\'a pas de contact_sol', true);
  pousserAnnule();
  evenements = [];
  for (const pied of ['gauche', 'droit']) {
    const c = data.contact_sol[pied];
    for (let i = 1; i < c.length; i++) {
      if (c[i] === 1 && c[i - 1] === 0) evenements.push({ pied, type: 'pose', image: i });
      if (c[i] === 0 && c[i - 1] === 1) evenements.push({ pied, type: 'lever', image: i });
    }
    if (c[0] === 1) evenements.push({ pied, type: 'pose', image: 0 });
  }
  evenements.sort((a, b) => a.image - b.image);
  marquerSale();
  majEvenements();
  majImage(true);
  afficherToast(`${evenements.length} événements détectés — vérifiez-les puis enregistrez`);
}

function marquerSale() {
  sale = true;
  $('btn-save').disabled = false;
  $('btn-save').classList.add('dirty');
}

function majEvenements() {
  $('ev-count').textContent = evenements.length;
  const liste = $('ev-list');
  liste.innerHTML = '';
  if (!evenements.length) {
    const li = document.createElement('li');
    li.id = 'ev-vide';
    li.textContent = 'Aucun événement — placez le premier avec les boutons ci-dessus';
    liste.appendChild(li);
  }
  const tries = evenements.map((e, i) => ({ ...e, i })).sort((a, b) => a.image - b.image);
  for (const e of tries) {
    const li = document.createElement('li');
    if (evenementChoisi && evenementChoisi === evenements[e.i]) li.className = 'selected';
    const initiale = e.pied === 'gauche' ? 'G' : 'D';
    li.innerHTML = `<span class="ev-arrow ${e.type}-${e.pied === 'gauche' ? 'g' : 'd'}">${e.type === 'pose' ? '▼' : '▲'}</span>
      <span class="ev-label">${e.type === 'pose' ? 'Pose' : 'Lever'} ${initiale}</span>
      <span class="ev-meta">img ${e.image} <span class="t">· ${nf2.format(e.image / data.frequence_hz)} s</span></span>`;
    const bDeplacer = document.createElement('button');
    bDeplacer.className = 'ev-btn-ico';
    bDeplacer.title = 'Déplacer à l\'image courante';
    bDeplacer.textContent = '✎';
    bDeplacer.addEventListener('click', (ev) => { ev.stopPropagation(); deplacerIci(e.i); });
    const bSuppr = document.createElement('button');
    bSuppr.className = 'ev-btn-ico';
    bSuppr.title = 'Supprimer';
    bSuppr.textContent = '✕';
    bSuppr.addEventListener('click', (ev) => { ev.stopPropagation(); supprimerEvenement(e.i); });
    li.appendChild(bDeplacer);
    li.appendChild(bSuppr);
    li.addEventListener('click', () => {
      evenementChoisi = evenements[e.i];
      allerA(e.image);
      majEvenements();
    });
    liste.appendChild(li);
  }
  majParametres();
}

/* ---------- Enregistrement en base ---------- */
async function enregistrer() {
  if (!courant || !sale) return;
  $('btn-save').disabled = true;
  try {
    await api(`evenements?essai_id=eq.${courant.id}`, { method: 'DELETE' });
    if (evenements.length) {
      const lignes = evenements.map((e) => ({
        essai_id: courant.id, pied: e.pied, type: e.type,
        image: e.image, temps_s: +(e.image / data.frequence_hz).toFixed(4),
      }));
      await api('evenements', { method: 'POST', body: JSON.stringify(lignes) });
    }
    await api(`essais?id=eq.${courant.id}`, {
      method: 'PATCH', body: JSON.stringify({ annotee: evenements.length > 0 }),
    });
    courant.annotee = evenements.length > 0;
    sale = false;
    $('btn-save').classList.remove('dirty');
    $('btn-save').disabled = true;
    dessinerArbre();
    afficherToast('Enregistré ✓');
  } catch (err) {
    afficherToast('Échec de l\'enregistrement', true);
    console.error(err);
    $('btn-save').disabled = !sale;
  }
}

/* ---------- Export Excel (CSV ouvert dans Excel) ---------- */
function exporterExcel() {
  const lignes = [['sujet', 'visite', 'essai', 'pied', 'evenement', 'image', 'temps_s']];
  const tries = evenements.map((e, i) => ({ ...e, i })).sort((a, b) => a.image - b.image);
  for (const e of tries) {
    lignes.push([courant.sujet, courant.visite, courant.numero, e.pied, e.type,
      e.image, (e.image / data.frequence_hz).toFixed(2).replace('.', ',')]);
  }
  const csv = '﻿' + lignes.map((l) => l.join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `evenements_${courant.sujet}_V${courant.visite}_E${courant.numero}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- Piste de timeline ---------- */
function dessinerPiste(canvasPiste, pied) {
  const nb = data.nb_images;
  const w = canvasPiste.clientWidth, h = canvasPiste.clientHeight;
  const dpr = Math.min(devicePixelRatio, 2);
  if (canvasPiste.width !== w * dpr || canvasPiste.height !== h * dpr) {
    canvasPiste.width = w * dpr; canvasPiste.height = h * dpr;
  }
  const ctx = canvasPiste.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const couleur = pied === 'gauche' ? '#4cc3f2' : '#f2913d';
  const x = (f) => 2 + (f / (nb - 1)) * (w - 4);

  // Phases d'appui (pose → lever) en fond
  const evs = evenements.filter((e) => e.pied === pied).sort((a, b) => a.image - b.image);
  for (let k = 0; k < evs.length; k++) {
    if (evs[k].type !== 'pose') continue;
    const lever = evs.find((e, j) => j > k && e.type === 'lever' && e.image >= evs[k].image);
    if (!lever) continue;
    const x1 = x(evs[k].image), x2 = x(lever.image);
    ctx.fillStyle = couleur + '55';
    ctx.beginPath();
    ctx.roundRect(x1, h / 2 - 6, Math.max(3, x2 - x1), 12, 6);
    ctx.fill();
  }
  // Marqueurs : ▼ pose, ▲ lever
  for (const e of evs) {
    const xm = x(e.image);
    ctx.fillStyle = couleur;
    ctx.beginPath();
    if (e.type === 'pose') {
      ctx.moveTo(xm - 5, 2); ctx.lineTo(xm + 5, 2); ctx.lineTo(xm, 11);
    } else {
      ctx.moveTo(xm - 5, h - 2); ctx.lineTo(xm + 5, h - 2); ctx.lineTo(xm, h - 11);
    }
    ctx.closePath();
    ctx.fill();
  }
  // Image courante
  ctx.fillStyle = '#ffffffcc';
  ctx.fillRect(x(frame) - 1, 0, 2, h);
}

// Cliquer-glisser sur la piste = aller à l'image
for (const id of ['tl-g', 'tl-d']) {
  const c = $(id);
  const aller = (e) => {
    if (!data) return;
    const rect = c.getBoundingClientRect();
    allerA((e.clientX - rect.left - 2) / (rect.width - 4) * (data.nb_images - 1));
  };
  c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); c.dataset.scrub = '1'; aller(e); });
  c.addEventListener('pointermove', (e) => { if (c.dataset.scrub === '1') aller(e); });
  c.addEventListener('pointerup', () => { c.dataset.scrub = '0'; });
}

/* ---------- Lecture ---------- */
function majBoutonLecture() {
  $('bt-play').textContent = lecture ? '⏸' : '▶';
}

function basculerLecture() {
  if (!data) return;
  if (!lecture && frame >= data.nb_images - 1) { frame = 0; position = 0; }
  lecture = !lecture;
  majBoutonLecture();
}

// Aller à une image précise (entier)
function allerA(f) {
  if (!data) return;
  frame = Math.min(data.nb_images - 1, Math.max(0, Math.round(f)));
  position = frame;
  majImage(true);
}

/* ---------- Boucle de rendu ---------- */
const horloge = new THREE.Clock();
function boucle() {
  requestAnimationFrame(boucle);
  const dt = horloge.getDelta();
  bougerCamera(dt);
  if (data && lecture) {
    position += dt * data.frequence_hz * vitesse;
    if (position >= data.nb_images - 1) {
      position = data.nb_images - 1;
      lecture = false;
      majBoutonLecture();
    }
    const f = Math.floor(position);
    if (f !== frame) {
      frame = f;
      majImage(true);
    }
  }
  renderer.render(scene, camera);
}

/* ---------- Redimensionnement ---------- */
const scene3d = $('stage');
function redimensionner() {
  const w = scene3d.clientWidth, h = scene3d.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (data) { dessinerPiste($('tl-g'), 'gauche'); dessinerPiste($('tl-d'), 'droit'); }
}
new ResizeObserver(redimensionner).observe(scene3d);

/* ---------- Clavier ---------- */
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  touches[e.code] = true;

  if (e.ctrlKey && e.code === 'KeyZ') {
    e.preventDefault();
    if (annulePile.length) {
      evenements = JSON.parse(annulePile.pop());
      evenementChoisi = null;
      marquerSale();
      majEvenements();
      majImage(true);
    }
    return;
  }
  switch (e.code) {
    case 'Space': e.preventDefault(); basculerLecture(); break;
    case 'ArrowLeft': e.preventDefault(); if (data) allerA(frame - 1); break;
    case 'ArrowRight': e.preventDefault(); if (data) allerA(frame + 1); break;
    case 'Home': allerA(0); break;
    case 'End': if (data) allerA(data.nb_images - 1); break;
    case 'Digit1': placerEvenement('gauche', 'pose'); break;
    case 'Digit2': placerEvenement('gauche', 'lever'); break;
    case 'Digit3': placerEvenement('droit', 'pose'); break;
    case 'Digit4': placerEvenement('droit', 'lever'); break;
  }
});
addEventListener('keyup', (e) => { delete touches[e.code]; });

/* ---------- Boutons ---------- */
// Après un clic, on retire le focus du bouton : sinon Espace re-clique le dernier bouton
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) b.blur();
});
$('bt-play').addEventListener('click', basculerLecture);
$('bt-prev').addEventListener('click', () => allerA(frame - 1));
$('bt-next').addEventListener('click', () => allerA(frame + 1));
$('bt-start').addEventListener('click', () => allerA(0));
$('bt-end').addEventListener('click', () => { if (data) allerA(data.nb_images - 1); });
for (const b of $('speeds').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    vitesse = parseFloat(b.dataset.speed);
    for (const x of $('speeds').querySelectorAll('button')) x.classList.toggle('on', x === b);
  });
}
for (const b of $('ev-buttons').querySelectorAll('.ev-btn')) {
  b.addEventListener('click', () => placerEvenement(b.dataset.pied, b.dataset.type));
}
$('btn-save').addEventListener('click', enregistrer);
$('btn-export').addEventListener('click', exporterExcel);
$('btn-auto').addEventListener('click', detecterAutomatique);
$('btn-clear').addEventListener('click', toutEffacer);

/* ---------- Messages ---------- */
let chronoToast = null;
function afficherToast(texte, erreur = false) {
  const t = $('toast');
  t.className = erreur ? 'erreur' : '';
  t.innerHTML = `<span>${texte}</span>`;
  t.hidden = false;
  clearTimeout(chronoToast);
  chronoToast = setTimeout(() => { t.hidden = true; }, 3000);
}

/* ---------- Démarrage ---------- */
redimensionner();
boucle();
chargerCatalogue()
  .then(() => { if (catalogue.length) return chargerEssai(catalogue[0]); })
  .catch((err) => {
    $('essai-title').textContent = 'Erreur';
    $('essai-sub').textContent = 'Base de données injoignable';
    console.error(err);
  });