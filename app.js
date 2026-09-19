import * as maplibregl from "https://unpkg.com/maplibre-gl@6.10.0/dist/maplibre-gl.mjs";
import { buffer as bufferGeometry } from "https://esm.sh/@turf/buffer@7.4.0";

const INITIAL_VIEW = { center: [10.35, 51.2], zoom: 6.05, pitch: 42, bearing: -6 };
const MAP_SOURCES = ["states", "state-caps"];

const PARTY_COLORS = {
  AfD: "#00d4ff", CDU: "#f2f4f8", CSU: "#3158ff", "CDU/CSU": "#547aff",
  SPD: "#ff2448", Greens: "#20e878", Left: "#ef2dff", FDP: "#ffe600",
  BSW: "#9b4dff", "Free Voters": "#ff8a00", SSW: "#00e0c2",
  BIW: "#ff5a36", Others: "#65758d"
};

const PARTY_DETAILS = {
  AfD: ["Alternative für Deutschland", "Federal party", "https://www.afd.de/"],
  CDU: ["Christlich Demokratische Union Deutschlands", "15 states · not Bavaria", "https://www.cdu.de/"],
  CSU: ["Christlich-Soziale Union in Bayern", "Bavaria", "https://www.csu.de/"],
  "CDU/CSU": ["CDU and CSU parliamentary alliance", "Federal alliance", "https://www.cducsu.de/"],
  SPD: ["Sozialdemokratische Partei Deutschlands", "Federal party", "https://www.spd.de/"],
  Greens: ["BÜNDNIS 90/DIE GRÜNEN", "Federal party", "https://www.gruene.de/"],
  Left: ["DIE LINKE", "Federal party", "https://www.die-linke.de/"],
  FDP: ["Freie Demokratische Partei", "Federal party", "https://www.fdp.de/"],
  BSW: ["Bündnis Sahra Wagenknecht – Vernunft und Gerechtigkeit", "Federal party", "https://bsw-vg.de/"],
  "Free Voters": ["FREIE WÄHLER", "Federal party · regional roots", "https://www.freiewaehler.eu/"],
  SSW: ["Südschleswigscher Wählerverband", "Danish and Frisian minority · Schleswig-Holstein", "https://www.ssw.de/"],
  BIW: ["Bürger in Wut", "Regional party · Bremen", "https://www.biw-fraktion-bremen.de/"]
};

const ELECTION_BUCKETS = [
  { days: 14, color: "#eaff38", height: 24000, label: "≤ 2 weeks" },
  { days: 365, color: "#ff9500", height: 18500, label: "≤ 1 year" },
  { days: 730, color: "#00d4ff", height: 14000, label: "≤ 2 years" },
  { days: Infinity, color: "#52637c", height: 9500, label: "Later" }
];

const VIEW_DESCRIPTIONS = {
  polls: "Colour shows the polling leader. Height shows their rating.",
  election: "Colour shows the last election winner. Height shows their vote share.",
  calendar: "Brighter, taller states vote sooner. Exact dates are official."
};

const PARTY_ALIASES = new Map([
  ["afd", "AfD"],
  ["cdu", "CDU"],
  ["csu", "CSU"],
  ["cdu/csu", "CDU/CSU"],
  ["spd", "SPD"],
  ["grüne", "Greens"],
  ["grünen", "Greens"],
  ["bündnis 90/die grünen", "Greens"],
  ["die grünen", "Greens"],
  ["linke", "Left"],
  ["die linke", "Left"],
  ["fdp", "FDP"],
  ["fdp/dvp", "FDP"],
  ["bsw", "BSW"],
  ["freie wähler", "Free Voters"],
  ["freiewähler", "Free Voters"],
  ["bvb/fw", "Free Voters"],
  ["ssw", "SSW"],
  ["biw", "BIW"],
  ["bündnis deutschland", "BIW"],
  ["sonstige", "Others"],
  ["übrige", "Others"],
  ["others", "Others"]
]);

const state = {
  meta: [],
  metaById: new Map(),
  geometry: null,
  capGeometry: null,
  elections: {},
  polls: {},
  pollUpdatedAt: null,
  selectedId: "11",
  view: "polls",
  map: null,
  bounds: null,
  hoveredId: null
};

const dom = {
  dataStatus: document.querySelector("#data-status"),
  nextCountdown: document.querySelector("#next-election-countdown"),
  polledCount: document.querySelector("#polled-state-count"),
  pollUpdateDate: document.querySelector("#poll-update-date"),
  viewDescription: document.querySelector("#view-description"),
  mapLegend: document.querySelector("#map-legend"),
  tooltip: document.querySelector("#map-tooltip"),
  stateName: document.querySelector("#state-name"),
  stateCapital: document.querySelector("#state-capital"),
  stateFlag: document.querySelector("#state-flag"),
  stateFlagCode: document.querySelector("#state-flag-code"),
  electionAlert: document.querySelector("#election-alert"),
  pollMethod: document.querySelector("#poll-method"),
  pollDate: document.querySelector("#poll-date"),
  partyBars: document.querySelector("#party-bars"),
  pollEmpty: document.querySelector("#poll-empty"),
  electionDate: document.querySelector("#election-date"),
  electionTurnout: document.querySelector("#election-turnout"),
  electionBars: document.querySelector("#election-bars"),
  electionSource: document.querySelector("#election-source"),
  statesTable: document.querySelector("#states-table"),
  partyTable: document.querySelector("#party-table"),
  partyCount: document.querySelector("#party-count"),
  pollLeaderCount: document.querySelector("#poll-leader-count"),
  leadChangeCount: document.querySelector("#lead-change-count"),
  powerShifts: document.querySelector("#power-shifts"),
  electionWatch: document.querySelector("#election-watch")
};

function normalizeParty(value = "") {
  const cleaned = String(value).trim();
  return PARTY_ALIASES.get(cleaned.toLocaleLowerCase("de")) || cleaned || "Others";
}

function partyInfo(party) {
  return { label: party === "Left" ? "The Left" : party, color: PARTY_COLORS[party] || PARTY_COLORS.Others };
}

function flagIcon(meta, className) {
  return `<img class="${className}" src="assets/flags/${meta.id}.svg" alt="" aria-hidden="true">`;
}

function mixHex(hex, target = "#ffffff", amount = 0.26) {
  const source = hex.match(/[a-f\d]{2}/gi).map((part) => parseInt(part, 16));
  const destination = target.match(/[a-f\d]{2}/gi).map((part) => parseInt(part, 16));
  return `#${source.map((value, index) => Math.round(value + (destination[index] - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function round1(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

function formatPercent(value) {
  return `${Number(value).toFixed(1)}%`;
}

function parseFlexibleDate(value) {
  if (!value) return null;
  const parts = value.split("-").map(Number);
  if (parts.length === 3) return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12));
  if (parts.length === 2) return new Date(Date.UTC(parts[0], parts[1] - 1, 15, 12));
  return new Date(Date.UTC(parts[0], 6, 1, 12));
}

function formatDate(value, options = { day: "numeric", month: "short", year: "numeric" }) {
  const date = value instanceof Date ? value : parseFlexibleDate(value);
  if (!date || Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(date);
}

function daysUntil(value) {
  if (!value || value.split("-").length !== 3) return null;
  const target = parseFlexibleDate(value);
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12);
  return Math.ceil((target.valueOf() - start) / 86_400_000);
}

function relativeElectionLabel(nextElection) {
  const days = daysUntil(nextElection.date);
  if (days === null) return nextElection.official ? "Official date" : "Expected window";
  if (days === 0) return "Election day";
  if (days === 1) return "Tomorrow";
  if (days > 1) return `${days.toLocaleString("en-GB")} days to go`;
  return "Date passed — awaiting update";
}

function electionUrgency(nextElection) {
  const date = parseFlexibleDate(nextElection.date);
  const days = Math.max(0, (date - new Date()) / 86_400_000);
  return ELECTION_BUCKETS.find((bucket) => days <= bucket.days);
}

function averagePolls(payload) {
  const parliamentIdByName = new Map(
    Object.entries(payload.Parliaments || {}).map(([id, item]) => [item.Shortcut, id])
  );
  const surveys = Object.values(payload.Surveys || {});
  const parties = payload.Parties || {};
  const output = {};

  for (const meta of state.meta) {
    const parliamentId = parliamentIdByName.get(meta.apiName);
    const candidates = surveys
      .filter((survey) => survey.Parliament_ID === parliamentId)
      .sort((a, b) => b.Date.localeCompare(a.Date));

    if (!candidates.length) continue;

    const latest = parseFlexibleDate(candidates[0].Date);
    const cutoff = new Date(latest);
    cutoff.setUTCDate(cutoff.getUTCDate() - 90);
    const instituteSeen = new Set();
    const included = candidates.filter((survey) => {
      if (parseFlexibleDate(survey.Date) < cutoff || instituteSeen.has(survey.Institute_ID)) return false;
      instituteSeen.add(survey.Institute_ID);
      return true;
    });

    const totals = new Map();
    for (const survey of included) {
      for (const [partyId, party] of Object.entries(parties)) {
        const canonical = normalizeParty(party.Shortcut);
        const value = Number(survey.Results?.[partyId] || 0);
        totals.set(canonical, (totals.get(canonical) || 0) + value);
      }
    }

    const results = [...totals.entries()]
      .map(([party, total]) => ({ party, value: round1(total / included.length) }))
      .filter((item) => item.value >= 0.1)
      .sort((a, b) => b.value - a.value);

    output[meta.id] = {
      date: candidates[0].Date,
      surveyCount: included.length,
      results
    };
  }

  return output;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function loadData() {
  const [meta, geometry, electionPayload, pollPayload] = await Promise.all([
    fetchJson("data/states-meta.json"),
    fetchJson("data/states.geojson"),
    fetchJson("data/election-results.json"),
    fetchJson("data/polls.json")
  ]);

  state.meta = meta;
  state.metaById = new Map(meta.map((item) => [item.id, item]));
  state.geometry = geometry;
  state.elections = electionPayload.states || {};

  state.polls = averagePolls(pollPayload);
  state.pollUpdatedAt = pollPayload.Database?.Last_Update || null;

  const updatedText = state.pollUpdatedAt
    ? formatDate(new Date(state.pollUpdatedAt), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })
    : "unknown";
  dom.dataStatus.textContent = `Daily snapshot · updated ${updatedText}`;
}

function prepareGeometry() {
  const bounds = new maplibregl.LngLatBounds();
  const addCoordinates = (coordinates) => {
    if (typeof coordinates[0] === "number") bounds.extend(coordinates);
    else coordinates.forEach(addCoordinates);
  };

  for (const feature of state.geometry.features) {
    const id = String(feature.properties.ars || feature.properties.id).padStart(2, "0");
    feature.properties.id = id;
    addCoordinates(feature.geometry.coordinates);
  }
  state.bounds = bounds;

  state.capGeometry = {
    ...state.geometry,
    features: state.geometry.features.map((feature) => {
      const inset = bufferGeometry(feature, -0.45, { units: "kilometers", steps: 2 });
      if (inset) inset.properties = feature.properties;
      return inset || feature;
    })
  };
}

function fitMap(duration = 0) {
  if (!state.map || !state.bounds) return;
  const compact = window.matchMedia("(max-width: 820px)").matches;
  state.map.fitBounds(state.bounds, {
    padding: compact ? { top: 28, right: 20, bottom: 132, left: 20 } : { top: 42, right: 42, bottom: 112, left: 42 },
    pitch: compact ? 34 : INITIAL_VIEW.pitch,
    bearing: compact ? -4 : INITIAL_VIEW.bearing,
    maxZoom: compact ? 5.65 : INITIAL_VIEW.zoom,
    duration
  });
}

function mapMetricFor(meta) {
  if (state.view === "calendar") {
    const urgency = electionUrgency(meta.nextElection);
    return {
      color: urgency.color,
      height: urgency.height,
      label: meta.nextElection.label.replace(/ 20\d\d$/, "")
    };
  }

  const source = state.view === "polls" ? state.polls[meta.id] : state.elections[meta.id];
  const leader = source?.results?.[0];
  if (!leader) return { color: PARTY_COLORS.Others, height: 7000, label: "No data" };
  const info = partyInfo(leader.party);
  return {
    color: info.color,
    height: 7000 + leader.value * 650,
    label: `${info.label} ${formatPercent(leader.value)}`
  };
}

function applyMapMetrics() {
  for (const feature of state.geometry.features) {
    const meta = state.metaById.get(feature.properties.id);
    const metric = mapMetricFor(meta);
    Object.assign(feature.properties, metric, { brightColor: mixHex(metric.color) });
  }

  state.map?.getSource("states")?.setData(state.geometry);
  state.map?.getSource("state-caps")?.setData(state.capGeometry);
}

function featureStateValue(selected, hover, normal) {
  return [
    "case",
    ["boolean", ["feature-state", "selected"], false], selected,
    ["boolean", ["feature-state", "hover"], false], hover,
    normal
  ];
}

function initMap() {
  state.map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {},
      light: {
        anchor: "viewport",
        color: "#ffffff",
        intensity: 0.86,
        position: [1.45, 145, 42]
      },
      layers: [{ id: "background", type: "background", paint: { "background-color": "rgba(3,5,8,0)" } }]
    },
    center: INITIAL_VIEW.center,
    zoom: INITIAL_VIEW.zoom,
    minZoom: 3.4,
    maxZoom: 8,
    maxPitch: 75,
    pitch: INITIAL_VIEW.pitch,
    bearing: INITIAL_VIEW.bearing,
    antialias: true,
    attributionControl: false
  });

  state.map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

  state.map.on("load", () => {
    // Every allowed map zoom overscales this baked geometry instead of generating a new LOD.
    const addSource = (id, data) => state.map.addSource(id, {
      type: "geojson",
      data,
      promoteId: "id",
      maxzoom: 5,
      tolerance: 0,
      buffer: 256
    });
    addSource("states", state.geometry);
    addSource("state-caps", state.capGeometry);

    const top = ["+", ["get", "height"], featureStateValue(4000, 1500, 0)];

    state.map.addLayer({
      id: "state-extrusions",
      type: "fill-extrusion",
      source: "states",
      paint: {
        "fill-extrusion-color": featureStateValue("#eaff38", ["get", "brightColor"], ["get", "color"]),
        "fill-extrusion-height": top,
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.98,
        "fill-extrusion-vertical-gradient": true
      }
    });

    state.map.addLayer({
      id: "state-outline-caps",
      type: "fill-extrusion",
      source: "states",
      paint: {
        "fill-extrusion-color": "#080b11",
        "fill-extrusion-height": ["+", top, 220],
        "fill-extrusion-base": ["-", top, 260],
        "fill-extrusion-opacity": 1,
        "fill-extrusion-vertical-gradient": false
      }
    });

    state.map.addLayer({
      id: "state-surface-caps",
      type: "fill-extrusion",
      source: "state-caps",
      paint: {
        "fill-extrusion-color": featureStateValue("#eaff38", ["get", "brightColor"], ["get", "color"]),
        "fill-extrusion-height": ["+", top, 360],
        "fill-extrusion-base": ["-", top, 80],
        "fill-extrusion-opacity": 0.98,
        "fill-extrusion-vertical-gradient": false
      }
    });

    state.map.addLayer({
      id: "state-gloss-caps",
      type: "fill-extrusion",
      source: "state-caps",
      paint: {
        "fill-extrusion-color": featureStateValue("#ffffff", "#ffffff", ["get", "brightColor"]),
        "fill-extrusion-height": ["+", top, 440],
        "fill-extrusion-base": ["+", top, 300],
        "fill-extrusion-opacity": 0.13,
        "fill-extrusion-vertical-gradient": false
      }
    });

    updateMapSelection();
    bindMapEvents();
    fitMap();
  });
}

function bindMapEvents() {
  const layers = ["state-gloss-caps", "state-surface-caps", "state-outline-caps", "state-extrusions"];

  state.map.on("mousemove", layers, (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    state.map.getCanvas().style.cursor = "pointer";
    const id = feature.properties.id;
    if (state.hoveredId !== id) {
      if (state.hoveredId) setMapFeatureState(state.hoveredId, { hover: false });
      state.hoveredId = id;
      setMapFeatureState(id, { hover: true });
    }
    const meta = state.metaById.get(id);
    dom.tooltip.innerHTML = `<span class="tooltip-title">${flagIcon(meta, "tooltip-flag")}<b>${meta.name}</b></span><span>${feature.properties.label}</span><small>Click anywhere in the state</small>`;
    dom.tooltip.hidden = false;
    const bounds = document.querySelector(".map-panel").getBoundingClientRect();
    dom.tooltip.style.left = `${Math.min(event.point.x + 15, bounds.width - 230)}px`;
    dom.tooltip.style.top = `${Math.max(12, event.point.y - 16)}px`;
  });

  state.map.on("mouseleave", layers, () => {
    state.map.getCanvas().style.cursor = "";
    dom.tooltip.hidden = true;
    if (state.hoveredId) setMapFeatureState(state.hoveredId, { hover: false });
    state.hoveredId = null;
  });

  state.map.on("click", layers, (event) => {
    const id = event.features?.[0]?.properties?.id;
    if (id) selectState(id, false);
  });
}

function setMapFeatureState(id, value) {
  for (const source of MAP_SOURCES) state.map.setFeatureState({ source, id }, value);
}

function updateMapSelection(previousId) {
  if (!state.map?.getSource("states")) return;
  if (previousId) setMapFeatureState(previousId, { selected: false });
  setMapFeatureState(state.selectedId, { selected: true });
}

function barRow(item, election) {
  const info = partyInfo(item.party);
  const previous = election?.results?.find((result) => result.party === item.party);
  const delta = previous ? round1(item.value - previous.value) : null;
  const deltaClass = delta > 0 ? "is-up" : delta < 0 ? "is-down" : "";
  const deltaText = delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`;
  return `
    <div class="party-row" style="--party-color:${info.color}">
      <div class="party-row-top">
        <span class="party-name"><i class="party-dot"></i>${info.label}</span>
        <span class="party-value">${formatPercent(item.value)}</span>
        <span class="party-delta ${deltaClass}" aria-label="${deltaText} percentage points versus last election">${deltaText}</span>
      </div>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="--value:${Math.min(100, item.value * 2.15)}%"></div></div>
    </div>`;
}

function miniBarRow(item) {
  const info = partyInfo(item.party);
  return `
    <div class="mini-row" style="--party-color:${info.color}">
      <span class="party-name"><i class="party-dot"></i>${info.label}</span>
      <div class="bar-track" aria-hidden="true"><div class="bar-fill" style="--value:${Math.min(100, item.value * 2.15)}%"></div></div>
      <span class="mini-value">${formatPercent(item.value)}</span>
    </div>`;
}

function renderDetails() {
  const meta = state.metaById.get(state.selectedId);
  const poll = state.polls[state.selectedId];
  const election = state.elections[state.selectedId];
  if (!meta) return;

  dom.stateName.textContent = meta.name;
  dom.stateCapital.textContent = `Capital · ${meta.capital}`;
  dom.stateFlag.src = `assets/flags/${meta.id}.svg`;
  dom.stateFlag.alt = `${meta.name} flag`;
  dom.stateFlagCode.textContent = `DE-${meta.iso}`;
  dom.electionAlert.innerHTML = `
    <div class="alert-label">NEXT STATE ELECTION</div>
    <div class="alert-value">
      <strong>${meta.nextElection.label}</strong>
      <span>${relativeElectionLabel(meta.nextElection)}</span>
    </div>`;

  if (poll?.results?.length) {
    dom.pollMethod.textContent = `${poll.surveyCount} recent ${poll.surveyCount === 1 ? "poll" : "polls"} · change vs last election`;
    dom.pollDate.textContent = formatDate(poll.date, { day: "numeric", month: "short", year: "numeric" });
    dom.partyBars.innerHTML = poll.results.slice(0, 8).map((item) => barRow(item, election)).join("");
    dom.partyBars.hidden = false;
    dom.pollEmpty.hidden = true;
  } else {
    dom.pollDate.textContent = "NO DATA";
    dom.partyBars.hidden = true;
    dom.pollEmpty.hidden = false;
  }

  if (election) {
    dom.electionDate.textContent = `${formatDate(election.date)}${election.provisional ? " · provisional" : " · final"}`;
    dom.electionTurnout.textContent = election.turnout ? `${election.turnout.toFixed(1)}% turnout` : "—";
    dom.electionBars.innerHTML = election.results.slice(0, 7).map(miniBarRow).join("");
    dom.electionSource.href = election.source;
    dom.electionSource.textContent = election.provisional ? "Official provisional result ↗" : "Official result ↗";
  }
}

function renderLegend() {
  if (state.view === "calendar") {
    dom.mapLegend.innerHTML = ELECTION_BUCKETS.map(({ color, label }) => `<span class="legend-item" style="--party-color:${color}"><i class="legend-swatch"></i>${label}</span>`).join("");
    return;
  }

  const used = new Set();
  for (const meta of state.meta) {
    const source = state.view === "polls" ? state.polls[meta.id] : state.elections[meta.id];
    if (source?.results?.[0]) used.add(source.results[0].party);
  }
  dom.mapLegend.innerHTML = [...used]
    .sort((a, b) => partyInfo(a).label.localeCompare(partyInfo(b).label))
    .map((party) => `<span class="legend-item" style="--party-color:${partyInfo(party).color}"><i class="legend-swatch"></i>${partyInfo(party).label}</span>`)
    .join("");
}

function renderTable() {
  const rows = [...state.meta].sort((a, b) => parseFlexibleDate(a.nextElection.date) - parseFlexibleDate(b.nextElection.date));
  dom.statesTable.innerHTML = rows.map((meta) => {
    const poll = state.polls[meta.id];
    const election = state.elections[meta.id];
    const pollLeader = poll?.results?.[0];
    const electionLeader = election?.results?.[0];
    const pollInfo = pollLeader ? partyInfo(pollLeader.party) : partyInfo("Others");
    const electionInfo = electionLeader ? partyInfo(electionLeader.party) : partyInfo("Others");
    return `
      <tr data-state-id="${meta.id}" class="${meta.id === state.selectedId ? "is-selected" : ""}">
        <td><button class="state-row-button" type="button" data-state-id="${meta.id}">${flagIcon(meta, "table-flag")}<span>${meta.name}</span></button></td>
        <td><span class="table-party" style="--party-color:${pollInfo.color}"><i class="party-dot"></i>${pollLeader ? pollInfo.label : "No recent poll"}</span></td>
        <td class="table-rating">${pollLeader ? formatPercent(pollLeader.value) : "—"}</td>
        <td><span class="table-party" style="--party-color:${electionInfo.color}"><i class="party-dot"></i>${electionLeader ? electionInfo.label : "—"}</span></td>
        <td>${meta.nextElection.label}${meta.nextElection.official ? '<span class="official-mark">OFFICIAL</span>' : ""}</td>
      </tr>`;
  }).join("");

}

function politicalSnapshot() {
  const parties = new Map();
  const shifts = [];
  const getParty = (party) => {
    if (!parties.has(party)) parties.set(party, { party, ratings: [], leads: 0, wins: 0, strongest: null });
    return parties.get(party);
  };

  for (const meta of state.meta) {
    const poll = state.polls[meta.id];
    const election = state.elections[meta.id];
    const pollLeader = poll?.results?.[0];
    const electionLeader = election?.results?.[0];

    for (const result of poll?.results || []) {
      if (result.party === "Others" || !PARTY_DETAILS[result.party]) continue;
      const party = getParty(result.party);
      party.ratings.push(result.value);
      if (!party.strongest || result.value > party.strongest.value) party.strongest = { ...result, meta };
    }
    if (pollLeader && PARTY_DETAILS[pollLeader.party]) getParty(pollLeader.party).leads += 1;
    if (electionLeader && PARTY_DETAILS[electionLeader.party]) getParty(electionLeader.party).wins += 1;
    if (pollLeader && electionLeader && pollLeader.party !== electionLeader.party) {
      shifts.push({ meta, pollLeader, electionLeader, election });
    }
  }

  return { parties: [...parties.values()], shifts };
}

function renderPartyLandscape(snapshot) {
  const parties = snapshot.parties
    .filter((party) => party.ratings.length)
    .map((party) => ({
      ...party,
      average: party.ratings.reduce((sum, value) => sum + value, 0) / party.ratings.length
    }))
    .sort((a, b) => b.leads - a.leads || b.average - a.average);

  dom.partyCount.textContent = parties.length;
  dom.pollLeaderCount.textContent = new Set(state.meta.map((meta) => state.polls[meta.id]?.results?.[0]?.party).filter(Boolean)).size;
  dom.leadChangeCount.textContent = snapshot.shifts.length;
  dom.partyTable.innerHTML = parties.map((party) => {
    const info = partyInfo(party.party);
    const [name, scope, url] = PARTY_DETAILS[party.party];
    return `
      <tr>
        <td><a class="party-key" href="${url}" target="_blank" rel="noopener noreferrer" style="--party-color:${info.color}"><i class="party-dot"></i><b>${info.label} ↗</b></a></td>
        <td><span class="party-profile"><b>${name}</b><small>${scope}</small></span></td>
        <td><strong class="data-number">${party.leads} / 16</strong></td>
        <td><strong class="data-number">${formatPercent(party.average)}</strong><small class="cell-note">across ${party.ratings.length} ${party.ratings.length === 1 ? "state" : "states"}</small></td>
        <td><button class="strongest-state" type="button" data-state-id="${party.strongest.meta.id}">${flagIcon(party.strongest.meta, "table-flag")}<span>${party.strongest.meta.name}<small>${formatPercent(party.strongest.value)}</small></span></button></td>
        <td><strong class="data-number">${party.wins}</strong></td>
      </tr>`;
  }).join("");
}

function renderPowerShifts(snapshot) {
  dom.powerShifts.innerHTML = snapshot.shifts
    .sort((a, b) => b.pollLeader.value - a.pollLeader.value)
    .map(({ meta, pollLeader, electionLeader, election }) => {
      const previous = partyInfo(electionLeader.party);
      const current = partyInfo(pollLeader.party);
      return `
        <button class="shift-card" type="button" data-state-id="${meta.id}">
          <span class="shift-state">${flagIcon(meta, "table-flag")}<b>${meta.name}</b></span>
          <span class="shift-route">
            <span style="--party-color:${previous.color}"><i class="party-dot"></i>${previous.label}<small>${formatDate(election.date, { year: "numeric" })} winner</small></span>
            <b aria-hidden="true">→</b>
            <span style="--party-color:${current.color}"><i class="party-dot"></i>${current.label}<small>polling at ${formatPercent(pollLeader.value)}</small></span>
          </span>
        </button>`;
    }).join("");
}

function renderElectionWatch() {
  dom.electionWatch.innerHTML = [...state.meta]
    .sort((a, b) => parseFlexibleDate(a.nextElection.date) - parseFlexibleDate(b.nextElection.date))
    .slice(0, 8)
    .map((meta) => {
      const leader = state.polls[meta.id]?.results?.[0];
      const info = partyInfo(leader?.party || "Others");
      const status = meta.nextElection.official ? "Official date" : "Expected window";
      const timing = relativeElectionLabel(meta.nextElection);
      return `
        <button class="watch-row" type="button" data-state-id="${meta.id}">
          <span class="watch-state">${flagIcon(meta, "table-flag")}<b>${meta.name}</b></span>
          <span class="watch-date"><b>${meta.nextElection.label}</b><small>${status}${timing === status ? "" : ` · ${timing}`}</small></span>
          <span class="watch-party" style="--party-color:${info.color}"><i class="party-dot"></i>${leader ? info.label : "No poll"}</span>
        </button>`;
    }).join("");
}

function renderPoliticalIntel() {
  const snapshot = politicalSnapshot();
  renderPartyLandscape(snapshot);
  renderPowerShifts(snapshot);
  renderElectionWatch();
}

function renderSummary() {
  const upcoming = state.meta.map((item) => daysUntil(item.nextElection.date)).filter((days) => days !== null && days >= 0);
  const nextDays = upcoming.length ? Math.min(...upcoming) : null;
  dom.nextCountdown.textContent = nextDays === 0 ? "Today" : nextDays === 1 ? "1 day" : nextDays !== null ? `${nextDays} days` : "—";
  dom.polledCount.textContent = `${Object.keys(state.polls).length} / 16`;
  dom.pollUpdateDate.textContent = state.pollUpdatedAt
    ? formatDate(new Date(state.pollUpdatedAt), { day: "numeric", month: "short" })
    : "—";
}

function renderView() {
  dom.viewDescription.textContent = VIEW_DESCRIPTIONS[state.view];
  document.querySelectorAll(".view-button").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  applyMapMetrics();
  updateMapSelection();
  renderLegend();
}

function selectState(id, fly = true) {
  const meta = state.metaById.get(id);
  if (!meta) return;
  const previousId = state.selectedId;
  state.selectedId = id;
  renderDetails();
  dom.statesTable.querySelector(".is-selected")?.classList.remove("is-selected");
  dom.statesTable.querySelector(`[data-state-id="${id}"]`)?.classList.add("is-selected");
  updateMapSelection(previousId);
  if (!fly || !state.map?.getSource("states")) return;
  if (window.matchMedia("(max-width: 820px)").matches) {
    fitMap(650);
    document.querySelector("#state-details").scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  state.map.flyTo({
    center: meta.label,
    zoom: ["02", "04", "11"].includes(id) ? 7.05 : 6.35,
    pitch: 46,
    bearing: id === "09" ? -20 : -13,
    duration: 900
  });
  document.querySelector("#state-details").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function bindUi() {
  document.querySelectorAll(".view-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      renderView();
    });
  });
  document.querySelector("#reset-map").addEventListener("click", () => {
    fitMap(850);
  });
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-state-id]");
    if (trigger) selectState(trigger.dataset.stateId, true);
  });
}

async function init() {
  bindUi();
  try {
    await loadData();
    prepareGeometry();
    applyMapMetrics();
    renderSummary();
    renderDetails();
    renderTable();
    renderPoliticalIntel();
    renderLegend();
    initMap();
  } catch (error) {
    console.error(error);
    dom.dataStatus.textContent = "Data could not be loaded";
    dom.stateName.textContent = "Data unavailable";
    dom.stateCapital.textContent = "Reload the page to try again.";
  }
}

init();
