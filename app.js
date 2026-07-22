const githubAuto = {
  enabled: true,
  owner: '',
  repo: '',
  branch: 'main',
};

const DEFAULT_POINT_COLOR = '#1976d2';
const map = L.map('map', { zoomControl: true, tap: true }).setView([59.33, 18.06], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' }).addTo(map);

const dom = {
  status: document.getElementById('status'),
  layersBtn: document.getElementById('layersBtn'),
  layersSheet: document.getElementById('layersSheet'),
  layersList: document.getElementById('layersList'),
  sharePosBtn: document.getElementById('sharePosBtn'),
  dropPinBtn: document.getElementById('dropPinBtn'),
};

const state = {
  mapsMeta: [],
  statusTimer: null,
  locationWatchId: null,
  userMarker: null,
  accuracyCircle: null,
  firstFix: true,
  shareMarker: null,
  dropMarker: null,
  placingDrop: false,
};

const dropIcon = L.divIcon({
  html: '<div class="drop-pin"></div>',
  className: '',
  iconSize: [18, 26],
  iconAnchor: [9, 26],
});

function filenameWithoutExt(path) {
  if (!path) return '';
  return path.split('/').pop().replace(/\.kml$/i, '');
}

function showStatus(message, timeout = 3000) {
  if (!message) {
    dom.status.hidden = true;
    dom.status.textContent = '';
    return;
  }
  dom.status.textContent = message;
  dom.status.hidden = false;
  window.clearTimeout(state.statusTimer);
  if (timeout) {
    state.statusTimer = window.setTimeout(() => {
      dom.status.hidden = true;
    }, timeout);
  }
}

function createButtonRow(...buttons) {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '8px';
  row.style.padding = '8px 4px';
  buttons.forEach((btn) => row.appendChild(btn));
  return row;
}

function renderLayersList() {
  dom.layersList.innerHTML = '';

  if (!state.mapsMeta.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Inga filer inlästa.';
    dom.layersList.appendChild(empty);
  } else {
    state.mapsMeta.forEach((meta) => {
      const row = document.createElement('div');
      row.className = 'file-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = map.hasLayer(meta.layer);
      cb.addEventListener('change', () => {
        if (cb.checked) map.addLayer(meta.layer);
        else map.removeLayer(meta.layer);
        renderLayersList();
      });

      const label = document.createElement('label');
      label.textContent = `${filenameWithoutExt(meta.name || meta.url)} (${meta.featureCount ?? '?'})`;

      row.append(cb, label);
      dom.layersList.appendChild(row);
    });
  }

  const showAllBtn = document.createElement('button');
  showAllBtn.className = 'small-btn';
  showAllBtn.textContent = 'Visa alla';
  showAllBtn.addEventListener('click', () => {
    state.mapsMeta.forEach((meta) => map.addLayer(meta.layer));
    renderLayersList();
  });

  const hideAllBtn = document.createElement('button');
  hideAllBtn.className = 'small-btn';
  hideAllBtn.textContent = 'Göm alla';
  hideAllBtn.addEventListener('click', () => {
    state.mapsMeta.forEach((meta) => map.removeLayer(meta.layer));
    renderLayersList();
  });

  dom.layersList.appendChild(createButtonRow(showAllBtn, hideAllBtn));
}

async function fetchText(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} för ${url}`);
  return res.text();
}

async function loadKml(url, _categoryName, displayName) {
  showStatus(`Laddar ${displayName || url}`, 2500);

  try {
    if (typeof toGeoJSON === 'undefined') {
      throw new Error('toGeoJSON saknas — lägg vendor/togeojson.min.js i repo');
    }

    const txt = await fetchText(url);
    const parser = new DOMParser();
    const kmlDoc = parser.parseFromString(txt, 'text/xml');
    const geojson = toGeoJSON.kml(kmlDoc);
    const featureCount = Array.isArray(geojson.features) ? geojson.features.length : 0;

    if (Array.isArray(geojson.features)) {
      geojson.features.forEach((feature) => {
        feature.properties ??= {};
        feature.properties._sourceMap = displayName || url;
      });
    }

    const layer = L.geoJSON(geojson, {
      style: () => ({ color: DEFAULT_POINT_COLOR, fillColor: DEFAULT_POINT_COLOR }),
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
        radius: 6,
        fillColor: DEFAULT_POINT_COLOR,
        color: '#fff',
        weight: 1,
        fillOpacity: 0.95,
      }),
      onEachFeature: (feature, lyr) => {
        const name = feature.properties?.name || '';
        const description = feature.properties?.description || '';
        const source = feature.properties?._sourceMap || '';
        let html = `<strong>${name}</strong><br/>`;
        if (description) html += description;
        if (source) html += `<hr/><em>${source}</em>`;
        lyr.bindPopup(html);
      },
    });

    state.mapsMeta.push({ url, name: displayName || url, layer, featureCount });
    renderLayersList();
    showStatus(`Inläst: ${displayName || url} (${featureCount} features)`, 3000);
  } catch (error) {
    console.error(error);
    showStatus(`Fel: ${error.message}`, 5000);
  }
}

async function loadAllKmlFromGitHub(owner, repo, branch, token) {
  if (!owner || !repo) throw new Error('owner eller repo saknas');

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/kml${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`;
  showStatus('Hämtar fil-lista från GitHub...', 4000);

  const headers = {};
  if (token) headers.Authorization = `token ${token}`;

  const res = await fetch(apiUrl, { headers });
  if (!res.ok) {
    if (res.status === 404) throw new Error('Katalogen /kml hittades inte i repo');
    throw new Error(`GitHub API HTTP ${res.status}`);
  }

  const entries = await res.json();
  if (!Array.isArray(entries)) throw new Error('GitHub svarade med oväntat format');

  const kmlFiles = entries.filter((entry) => entry.type === 'file' && entry.name.toLowerCase().endsWith('.kml'));
  if (!kmlFiles.length) {
    showStatus('Inga .kml i /kml', 5000);
    return;
  }

  showStatus(`Laddar ${kmlFiles.length} KML-filer...`, 4000);
  for (const file of kmlFiles) {
    try {
      await loadKml(file.download_url, null, file.name);
    } catch (error) {
      console.warn('Misslyckades ladda', file.name, error);
    }
  }

  showStatus('Alla tillgängliga KML-filer är inlästa.', 3000);
}

function detectOwnerRepoFromLocation() {
  try {
    const { hostname, pathname } = window.location;
    if (!hostname.endsWith('.github.io')) return null;
    const owner = hostname.split('.')[0];
    const repo = pathname.split('/').filter(Boolean)[0] || null;
    return owner && repo ? { owner, repo } : null;
  } catch {
    return null;
  }
}

function startLocationTracking(options = { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }) {
  if (!('geolocation' in navigator)) {
    showStatus('Geolocation stöds inte i denna webbläsare', 5000);
    return;
  }
  if (state.locationWatchId !== null) return;

  state.firstFix = true;
  state.locationWatchId = navigator.geolocation.watchPosition((pos) => {
    const { latitude: lat, longitude: lng, accuracy: acc = 0 } = pos.coords;

    if (!state.userMarker) {
      state.userMarker = L.circleMarker([lat, lng], {
        radius: 8,
        color: '#ffffff',
        weight: 2,
        fillColor: '#ff0000',
        fillOpacity: 0.95,
        pane: 'markerPane',
      }).addTo(map);
    } else {
      state.userMarker.setLatLng([lat, lng]);
    }

    if (!state.accuracyCircle) {
      state.accuracyCircle = L.circle([lat, lng], {
        radius: acc,
        color: '#ff0000',
        weight: 1,
        opacity: 0.25,
        fillOpacity: 0.05,
        interactive: false,
      }).addTo(map);
    } else {
      state.accuracyCircle.setLatLng([lat, lng]);
      state.accuracyCircle.setRadius(acc);
    }

    if (state.firstFix) {
      try {
        map.setView([lat, lng], Math.max(map.getZoom(), 14));
      } catch {}
      state.firstFix = false;
    }
  }, (error) => {
    console.warn('Geolocation error', error);
    showStatus(`GPS-fel: ${error.message || error.code}`, 4000);
  }, options);
}

function stopLocationTracking() {
  if (state.locationWatchId !== null) {
    navigator.geolocation.clearWatch(state.locationWatchId);
    state.locationWatchId = null;
  }
  if (state.userMarker) map.removeLayer(state.userMarker);
  if (state.accuracyCircle) map.removeLayer(state.accuracyCircle);
  state.userMarker = null;
  state.accuracyCircle = null;
  state.firstFix = true;
}

function createShareUrl(lat, lng, zoom, type = 'gps') {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?loc=${lat.toFixed(6)},${lng.toFixed(6)}&z=${zoom}&t=${encodeURIComponent(type)}`;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showStatus('Länk kopierad till urklipp', 3500);
  } catch (error) {
    showStatus(`Kunde inte kopiera — här är länken: ${text}`, 6000);
    console.warn('Clipboard error', error);
  }
}

function placeShareMarker(lat, lng) {
  if (!state.shareMarker) {
    state.shareMarker = L.circleMarker([lat, lng], {
      radius: 8,
      color: '#fff',
      weight: 2,
      fillColor: '#ff5722',
      fillOpacity: 0.95,
    }).addTo(map);
  } else {
    state.shareMarker.setLatLng([lat, lng]);
  }
}

function markAndShareCurrentLocation() {
  if (!('geolocation' in navigator)) {
    showStatus('Geolocation stöds inte', 4000);
    return;
  }

  showStatus('Hämtar din position…', 4000);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lng } = pos.coords;
    const zoom = map.getZoom() || 14;
    placeShareMarker(lat, lng);
    map.setView([lat, lng], Math.max(zoom, 14));
    await copyToClipboard(createShareUrl(lat, lng, map.getZoom(), 'gps'));
  }, (error) => {
    showStatus(`Kunde inte hämta position: ${error.message || error.code}`, 5000);
    console.warn('Geolocation error', error);
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
}

function placeDropMarker(lat, lng, shareAfter = false) {
  if (!state.dropMarker) {
    state.dropMarker = L.marker([lat, lng], { icon: dropIcon, draggable: true }).addTo(map);
    state.dropMarker.on('dragend', (ev) => {
      const point = ev.target.getLatLng();
      const url = createShareUrl(point.lat, point.lng, map.getZoom(), 'drop');
      copyToClipboard(url);
      showStatus('Nål flyttad — länk uppdaterad och kopierad', 3000);
    });
  } else {
    state.dropMarker.setLatLng([lat, lng]);
  }

  if (shareAfter) {
    const url = createShareUrl(lat, lng, map.getZoom(), 'drop');
    copyToClipboard(url);
    showStatus('Nål placerad och länk kopierad', 3500);
  }
}

function startPlacingDropPin() {
  if (state.placingDrop) {
    showStatus('Redan i placeringsläge — klicka på kartan.', 2500);
    return;
  }

  state.placingDrop = true;
  showStatus('Klicka på kartan för att placera en grön nål', 5000);
  map.getContainer().style.cursor = 'crosshair';

  map.once('click', (e) => {
    try {
      placeDropMarker(e.latlng.lat, e.latlng.lng, true);
      map.setView([e.latlng.lat, e.latlng.lng], Math.max(map.getZoom(), 14));
    } finally {
      state.placingDrop = false;
      map.getContainer().style.cursor = '';
    }
  });

  window.setTimeout(() => {
    if (state.placingDrop) {
      state.placingDrop = false;
      map.getContainer().style.cursor = '';
      showStatus('Placeringsläge avbrutet', 2000);
    }
  }, 60000);
}

function restoreFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const loc = params.get('loc');
    const z = params.get('z');
    const t = params.get('t');
    if (!loc) return;

    const [latStr, lngStr] = loc.split(',');
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;

    const zoom = z ? parseInt(z, 10) : map.getZoom();
    if (t === 'drop') placeDropMarker(lat, lng, false);
    else placeShareMarker(lat, lng);
    map.setView([lat, lng], Number.isNaN(zoom) ? 14 : zoom);
  } catch {}
}

function placeShareMarker(lat, lng) {
  if (!state.shareMarker) {
    state.shareMarker = L.circleMarker([lat, lng], {
      radius: 8,
      color: '#fff',
      weight: 2,
      fillColor: '#ff5722',
      fillOpacity: 0.95,
    }).addTo(map);
  } else {
    state.shareMarker.setLatLng([lat, lng]);
  }
}

function openLayersSheet() {
  const open = dom.layersSheet.classList.toggle('open');
  dom.layersSheet.setAttribute('aria-hidden', (!open).toString());
  if (open) renderLayersList();
}

async function init() {
  if (githubAuto.enabled) {
    let { owner, repo } = githubAuto;
    const { branch, token } = githubAuto;

    if (!owner || !repo) {
      const detected = detectOwnerRepoFromLocation();
      if (detected) {
        owner = owner || detected.owner;
        repo = repo || detected.repo;
      }
    }

    if (!owner || !repo) {
      showStatus('Automatisk GitHub-laddning: owner/repo ej angivet och kunde ej upptäckas.', 4000);
    } else {
      try {
        await loadAllKmlFromGitHub(owner, repo, branch, token);
      } catch (error) {
        console.error(error);
        showStatus(`GitHub-auto fel: ${error.message}`, 5000);
      }
    }
  } else {
    showStatus('Automatisk GitHub-laddning inaktiverad');
  }

  restoreFromUrl();

  try {
    startLocationTracking();
  } catch (error) {
    console.warn('Kunde inte starta geolocation automatiskt', error);
  }
}

dom.layersBtn.addEventListener('click', openLayersSheet);
dom.sharePosBtn.addEventListener('click', markAndShareCurrentLocation);
dom.dropPinBtn.addEventListener('click', startPlacingDropPin);
map.on('click', () => {
  if (dom.layersSheet.classList.contains('open')) {
    dom.layersSheet.classList.remove('open');
    dom.layersSheet.setAttribute('aria-hidden', 'true');
  }
});

window.AppKml = {
  load: (url, name) => loadKml(url, null, name),
  listFiles: () => state.mapsMeta.map((meta) => ({
    name: filenameWithoutExt(meta.name || meta.url),
    url: meta.url,
    count: meta.featureCount,
  })),
  startLocation: startLocationTracking,
  stopLocation: stopLocationTracking,
  shareNow: markAndShareCurrentLocation,
  dropPinMode: startPlacingDropPin,
  placeDropMarker,
};

init();
