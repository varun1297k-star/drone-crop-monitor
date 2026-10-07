/* =====================================================================
   DRONE VISION - CROP HEALTH MONITOR
   ---------------------------------------------------------------------
   How the program is organised (read from top to bottom):
     1. Settings            - numbers you can change
     2. Page elements       - links to things on the page
     3. Camera and upload   - getting a picture
     4. Colour analysis     - the health score (%)
     5. AI model            - the problem type (Teachable Machine)
     6. Deciding the result - combining score + AI, and the advice
     7. Live reading        - updates twice a second
     8. Scanning zones      - the field map
     9. Drawing the page    - grid, details, summary
    10. Demo mode, saving, settings sliders, start-up
   ===================================================================== */


/* ============================ 1. SETTINGS ============================ */

const SETTINGS = {
  healthyAbove: 75,     // score above this  = Healthy (green)
  warningAbove: 40,     // score below this  = Critical (red). In between = Warning (yellow)
  bgTolerance: 0.06,    // how close a pixel's colour must be to the background colour to be removed
  minLeafPercent: 3,    // if less than 3% of the picture is leaf, we say "No plant"
  aiMinConfidence: 0.6, // we only trust the AI when it is at least 60% sure
  scanSeconds: 2,       // how long one scan takes
  autoCountdown: 5      // seconds to move the drone between zones in auto-scan
};

// Hue is the "colour angle" from 0 to 360 (0 = red, 60 = yellow, 120 = green).
const HUE_YELLOW_START = 40;   // below this = brown / red-brown
const HUE_GREEN_START = 65;    // 40 to 65  = yellow
const HUE_GREEN_END = 170;     // 65 to 170 = green. Above 170 (blue, purple) is not a leaf.

const ZONES = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"];
const SIZE = 224;              // every picture is shrunk to 224 x 224 pixels before analysis

// Advice shown for each problem type.
const PROBLEMS = {
  healthy:   { label: "Healthy",     advice: "No action needed. Keep monitoring." },
  yellowing: { label: "Yellowing",   advice: "Possible nutrient deficiency. Check fertiliser and water." },
  brown:     { label: "Brown spots", advice: "Possible fungal infection. Inspect and treat." },
  dry:       { label: "Dry",         advice: "Water shortage. Increase irrigation." },
  unknown:   { label: "Unhealthy",   advice: "Looks unhealthy. Inspect this zone by hand." },
  none:      { label: "No plant",    advice: "No plant found in this zone." }
};

// Things that change while the program runs.
let results = {};            // one result per zone, for example results["A1"]
let currentZone = 0;         // position in the ZONES list (0 = A1)
let source = "none";         // "camera", "image" or "none"
let cameraStream = null;
let model = null;            // the Teachable Machine model (null = not loaded)
let busy = false;            // true while a scan is running
let autoRunning = false;     // true while auto-scan is running
let liveBusy = false;
let fieldView = false;       // true = the camera sees the whole tray and all 9 zones are scanned at once


/* ========================= 2. PAGE ELEMENTS ========================= */

const $ = (id) => document.getElementById(id);

const video = $("video");
const uploadedImage = $("uploadedImage");
const captureCanvas = $("captureCanvas");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true });
const maskCanvas = $("maskCanvas");
const maskCtx = maskCanvas.getContext("2d");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Makes text safe to put inside HTML (class names come from the model file).
function safe(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}


/* ======================== 3. CAMERA AND UPLOAD ======================== */

async function startCamera(deviceId) {
  stopCamera();
  $("cameraMessage").textContent = "";

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $("cameraMessage").textContent =
      "Camera is not available here (the page must be opened with https or localhost). Use Upload photo.";
    return;
  }

  try {
    // "environment" asks a phone for its back camera.
    const wanted = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" };
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: wanted, audio: false });
    video.srcObject = cameraStream;
    await video.play();

    source = "camera";
    video.classList.remove("hidden");
    uploadedImage.classList.add("hidden");
    $("noSource").classList.add("hidden");
    $("startCameraBtn").textContent = "Restart camera";
    await listCameras();
  } catch (error) {
    console.error(error);
    source = "none";
    $("noSource").classList.remove("hidden");
    $("cameraMessage").textContent =
      "Could not open the camera (" + error.name + "). Allow camera permission, or use Upload photo.";
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
}

// Fills the drop-down so you can pick another camera (for example a USB or drone camera).
async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === "videoinput");
  const select = $("cameraSelect");
  const activeId = cameraStream.getVideoTracks()[0].getSettings().deviceId;

  select.innerHTML = "";
  cameras.forEach((cam, i) => {
    const option = document.createElement("option");
    option.value = cam.deviceId;
    option.textContent = cam.label || "Camera " + (i + 1);
    option.selected = cam.deviceId === activeId;
    select.appendChild(option);
  });
  select.classList.toggle("hidden", cameras.length < 2);
}

// Upload fallback: show a photo instead of the camera.
function useUploadedPhoto(file) {
  if (!file) return;
  uploadedImage.onload = () => {
    stopCamera();
    source = "image";
    uploadedImage.classList.remove("hidden");
    video.classList.add("hidden");
    $("noSource").classList.add("hidden");
    $("cameraMessage").textContent = "Using uploaded photo. Upload another photo for the next zone.";
    updateLive();
  };
  uploadedImage.src = URL.createObjectURL(file);
}

// Copies the middle square of the camera picture (or photo) onto the hidden canvas.
// Returns false if there is no picture yet.
// If "cell" is given (0 to 8), it copies only that ninth of the square instead.
// That is how the whole-field view cuts one picture into 9 zones.
function grabFrame(cell) {
  let picture, width, height;

  if (source === "camera" && video.readyState >= 2) {
    picture = video; width = video.videoWidth; height = video.videoHeight;
  } else if (source === "image" && uploadedImage.naturalWidth > 0) {
    picture = uploadedImage; width = uploadedImage.naturalWidth; height = uploadedImage.naturalHeight;
  } else {
    return false;
  }
  if (!width || !height) return false;

  let side = Math.min(width, height);
  let left = (width - side) / 2;
  let top = (height - side) / 2;

  if (cell !== undefined) {
    side = side / 3;
    left += (cell % 3) * side;             // column 0, 1 or 2
    top += Math.floor(cell / 3) * side;    // row 0, 1 or 2
  }

  captureCtx.drawImage(picture, left, top, side, side, 0, 0, SIZE, SIZE);
  return true;
}


/* ========================= 4. COLOUR ANALYSIS ========================= */

// Converts one pixel from Red-Green-Blue to Hue-Saturation-Value.
//   hue        = which colour (0 to 360)
//   saturation = how strong the colour is (0 = grey/white, 1 = very colourful)
//   value      = how bright it is (0 = black, 1 = bright)
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const diff = max - min;

  let hue = 0;
  if (diff !== 0) {
    if (max === r) hue = 60 * (((g - b) / diff) % 6);
    else if (max === g) hue = 60 * ((b - r) / diff + 2);
    else hue = 60 * ((r - g) / diff + 4);
  }
  if (hue < 0) hue += 360;

  const saturation = max === 0 ? 0 : diff / max;
  return [hue, saturation, max];
}

// ---- Background removal, part 1: what colour is the background? ----
// The leaf is in the middle, so the outer edge of the picture is background.
// We take the middle (median) colour of the edge pixels.
// The colour is stored as "share of red" and "share of green", ignoring brightness.
// That way a shadow (same colour, only darker) still counts as background.
const WHITE_BACKGROUND = { red: 1 / 3, green: 1 / 3 };
const EDGE = 16;   // width of the edge strip, in pixels

function findBackgroundColour(pixels) {
  const reds = [], greens = [];

  for (let y = 0; y < SIZE; y += 2) {
    for (let x = 0; x < SIZE; x += 2) {
      const inMiddle = x >= EDGE && x < SIZE - EDGE && y >= EDGE && y < SIZE - EDGE;
      if (inMiddle) continue;
      const i = (y * SIZE + x) * 4;
      const sum = pixels[i] + pixels[i + 1] + pixels[i + 2];
      if (sum < 60) continue;                // too dark to tell its colour
      reds.push(pixels[i] / sum);
      greens.push(pixels[i + 1] / sum);
    }
  }
  if (reds.length < 50) return WHITE_BACKGROUND;

  reds.sort((a, b) => a - b);
  greens.sort((a, b) => a - b);
  const red = reds[Math.floor(reds.length / 2)];
  const green = greens[Math.floor(greens.length / 2)];
  const blue = 1 - red - green;

  // If the edge is green, the leaf is filling the whole picture.
  // Then we cannot see the background, so we assume it is white or grey.
  if (green > 0.4 && green > red + 0.04 && green > blue + 0.04) return WHITE_BACKGROUND;

  return { red: red, green: green };
}

// ---- Background removal, part 2: keep only the main leaf shapes ----
// "kinds" has one number per pixel: 0 = background, 1 = green, 2 = yellow, 3 = brown.
// Pixels that touch each other form a shape. Small shapes (specks, bits of
// clutter) are removed: only the biggest shape and any shape at least a fifth
// of its size are kept.
function keepMainShapes(kinds) {
  const shapeOf = new Int32Array(kinds.length);   // which shape each pixel belongs to (0 = none yet)
  const todo = new Int32Array(kinds.length);      // list of pixels still to visit
  const sizes = [0];                              // sizes[n] = number of pixels in shape n
  let biggest = 0;

  for (let start = 0; start < kinds.length; start++) {
    if (kinds[start] === 0 || shapeOf[start] !== 0) continue;

    // Found a new shape: spread out from this pixel to all its touching neighbours.
    const shape = sizes.length;
    let count = 0, waiting = 0;
    todo[waiting++] = start;
    shapeOf[start] = shape;

    while (waiting > 0) {
      const p = todo[--waiting];
      count++;
      const x = p % SIZE;
      const neighbours = [p - SIZE, p + SIZE, x > 0 ? p - 1 : -1, x < SIZE - 1 ? p + 1 : -1];
      for (const n of neighbours) {
        if (n >= 0 && n < kinds.length && kinds[n] !== 0 && shapeOf[n] === 0) {
          shapeOf[n] = shape;
          todo[waiting++] = n;
        }
      }
    }
    sizes.push(count);
    if (count > biggest) biggest = count;
  }

  for (let p = 0; p < kinds.length; p++) {
    if (kinds[p] !== 0 && sizes[shapeOf[p]] < biggest * 0.2) kinds[p] = 0;
  }
}

// Colours used to paint "what the computer sees": background, green, yellow, brown.
const MASK_COLOURS = [[225, 228, 224], [30, 158, 74], [240, 200, 0], [140, 80, 30]];

// Looks at every pixel on the hidden canvas and counts green, yellow and brown ones.
// If drawMask is true it also paints "what the computer sees".
function analyseColours(drawMask) {
  const image = captureCtx.getImageData(0, 0, SIZE, SIZE);
  const pixels = image.data;                 // 4 numbers per pixel: red, green, blue, alpha
  const background = findBackgroundColour(pixels);
  const kinds = new Uint8Array(SIZE * SIZE); // 0 = background, 1 = green, 2 = yellow, 3 = brown

  for (let p = 0; p < kinds.length; p++) {
    const i = p * 4;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const sum = r + g + b;
    const [hue, , value] = rgbToHsv(r, g, b);

    // Step 1: is this pixel background? Yes if it is very dark, or if its colour
    // is close to the background colour (brightness does not matter, so shadows go too).
    const redDifference = r / sum - background.red;
    const greenDifference = g / sum - background.green;
    const difference = Math.sqrt(redDifference * redDifference + greenDifference * greenDifference);
    if (value < 0.12 || difference < SETTINGS.bgTolerance) continue;

    // Step 2: it is not background, so which colour group is it?
    if (hue >= HUE_GREEN_START && hue <= HUE_GREEN_END) kinds[p] = 1;
    else if (hue >= HUE_YELLOW_START && hue < HUE_GREEN_START) kinds[p] = 2;
    else if (hue < HUE_YELLOW_START || hue > 330) kinds[p] = 3;
    // any other hue (blue, purple) is not a leaf, so it stays background
  }

  // Step 3: throw away small specks that are not part of the leaf.
  keepMainShapes(kinds);

  let green = 0, yellow = 0, brown = 0;
  const mask = drawMask ? maskCtx.createImageData(SIZE, SIZE) : null;
  for (let p = 0; p < kinds.length; p++) {
    if (kinds[p] === 1) green++;
    else if (kinds[p] === 2) yellow++;
    else if (kinds[p] === 3) brown++;

    if (mask) {
      const colour = MASK_COLOURS[kinds[p]];
      mask.data[p * 4] = colour[0]; mask.data[p * 4 + 1] = colour[1]; mask.data[p * 4 + 2] = colour[2];
      mask.data[p * 4 + 3] = 255;
    }
  }
  if (mask) maskCtx.putImageData(mask, 0, 0);

  const leaf = green + yellow + brown;
  const total = SIZE * SIZE;
  return {
    leafPercent: (leaf / total) * 100,                 // how much of the picture is leaf
    health: leaf ? (green / leaf) * 100 : 0,           // THE HEALTH SCORE
    yellowPercent: leaf ? (yellow / leaf) * 100 : 0,
    brownPercent: leaf ? (brown / leaf) * 100 : 0
  };
}

// Averages several colour readings so one shaky frame does not change the answer.
function averageReadings(readings) {
  const average = { leafPercent: 0, health: 0, yellowPercent: 0, brownPercent: 0 };
  readings.forEach((r) => { for (const key in average) average[key] += r[key] / readings.length; });
  return average;
}


/* ============================ 5. AI MODEL ============================ */

function showModelStatus(text, good) {
  $("modelStatus").textContent = text;
  $("modelStatus").className = "pill " + (good ? "good" : "bad");
}

// Loads the Teachable Machine model from the "model" folder.
async function loadModel() {
  try {
    model = await tmImage.load("model/model.json", "model/metadata.json");
    showModelStatus("AI model: ready (" + model.getTotalClasses() + " classes)", true);
  } catch (error) {
    model = null;
    showModelStatus("AI model: not found - colour analysis only", false);
  }
}

// Backup: load the model from files chosen by the user (Settings).
async function loadModelFromFiles(fileList) {
  const files = Array.from(fileList);
  const modelFile = files.find((f) => f.name === "model.json");
  const metadataFile = files.find((f) => f.name === "metadata.json");
  const weightsFile = files.find((f) => f.name.endsWith(".bin"));

  if (!modelFile || !metadataFile || !weightsFile) {
    showModelStatus("Select model.json, metadata.json and weights.bin together", false);
    return;
  }
  try {
    model = await tmImage.loadFromFiles(modelFile, weightsFile, metadataFile);
    showModelStatus("AI model: ready (" + model.getTotalClasses() + " classes)", true);
  } catch (error) {
    console.error(error);
    model = null;
    showModelStatus("AI model: could not load those files", false);
  }
}

// Turns a class name from Teachable Machine into one of our problem types.
// It only looks for a key word, so "Brown spots" and "brown_spots" both work.
function problemFromClassName(name) {
  const n = name.toLowerCase();
  if (n.includes("no leaf") || n.includes("background") || n.includes("none") || n.includes("empty")) return "none";
  if (n.includes("health")) return "healthy";
  if (n.includes("yellow")) return "yellowing";
  if (n.includes("brown") || n.includes("spot")) return "brown";
  if (n.includes("dry") || n.includes("wilt") || n.includes("wither")) return "dry";
  return "unknown";
}

// Asks the AI what it sees on the hidden canvas. Returns null if no model is loaded.
async function classify() {
  if (!model) return null;
  try {
    const predictions = await model.predict(captureCanvas);
    let best = predictions[0];
    predictions.forEach((p) => { if (p.probability > best.probability) best = p; });
    return {
      className: best.className,
      confidence: best.probability,              // 0 to 1
      problem: problemFromClassName(best.className)
    };
  } catch (error) {
    console.error(error);
    return null;
  }
}


/* ====================== 6. DECIDING THE RESULT ====================== */

function statusFromScore(score) {
  if (score > SETTINGS.healthyAbove) return "healthy";
  if (score >= SETTINGS.warningAbove) return "warning";
  return "critical";
}

const STATUS_LABELS = { healthy: "Healthy", warning: "Warning", critical: "Critical", empty: "No plant" };

// Combines the colour score and the AI answer into one result.
function decideResult(colour, ai) {
  const result = {
    health: Math.round(colour.health),
    yellowPercent: Math.round(colour.yellowPercent),
    brownPercent: Math.round(colour.brownPercent),
    aiClass: ai ? ai.className : null,
    aiConfidence: ai ? Math.round(ai.confidence * 100) : null
  };

  // Not enough leaf in the picture.
  if (colour.leafPercent < SETTINGS.minLeafPercent) {
    return Object.assign(result, { status: "empty", problem: "none", decidedBy: "colour", health: null });
  }

  result.status = statusFromScore(colour.health);

  // A guess at the problem using colours only (used when there is no AI model).
  let colourProblem = "healthy";
  if (result.status !== "healthy") {
    colourProblem = colour.yellowPercent >= colour.brownPercent ? "yellowing" : "brown";
  }

  // Trust the AI only if it is confident and it saw a leaf.
  const aiTrusted = ai && ai.confidence >= SETTINGS.aiMinConfidence && ai.problem !== "none";

  if (aiTrusted) {
    result.problem = ai.problem;
    result.decidedBy = "AI";
    // The AI found a problem that the colour score missed: raise a warning.
    if (ai.problem !== "healthy" && result.status === "healthy") result.status = "warning";
    // The colour score is low but the AI says healthy: keep the colour's problem type.
    if (ai.problem === "healthy" && result.status !== "healthy") {
      result.problem = colourProblem;
      result.decidedBy = "colour";
    }
  } else {
    result.problem = colourProblem;
    result.decidedBy = "colour";
  }
  return result;
}

// The name to show for a result's problem type.
function problemLabel(result) {
  if (result.problem === "unknown" && result.aiClass) return result.aiClass;
  return PROBLEMS[result.problem].label;
}


/* ========================== 7. LIVE READING ========================== */

async function updateLive() {
  if (liveBusy || busy) return;
  liveBusy = true;
  try {
    if (!grabFrame()) return;
    const colour = analyseColours(true);
    const ai = await classify();
    const result = decideResult(colour, ai);
    showLive(result);
  } finally {
    liveBusy = false;
  }
}

function showLive(result) {
  $("liveHealth").textContent = result.health === null ? "--" : result.health + "%";
  $("liveHealth").className = "big-number text-" + result.status;
  $("liveStatus").textContent = result.status === "empty"
    ? "No leaf in view"
    : STATUS_LABELS[result.status] + " - " + problemLabel(result);
  $("liveStatus").className = "status-label text-" + result.status;
  $("liveAI").textContent = result.aiClass
    ? "AI: " + result.aiClass + " (" + result.aiConfidence + "% sure)"
    : "AI: model not loaded";
  $("liveColours").textContent = result.status === "empty"
    ? "Colours: --"
    : "Colours: green " + result.health + "%, yellow " + result.yellowPercent + "%, brown " + result.brownPercent + "%";
}


/* ========================= 8. SCANNING ZONES ========================= */

// Scans the zone that is currently selected on the map.
async function scanZone() {
  if (busy) return;
  const zone = ZONES[currentZone];

  if (!grabFrame()) {
    $("scanMessage").textContent = "No picture yet. Start the camera or upload a photo first.";
    return;
  }

  busy = true;
  setButtons();
  $("scanText").textContent = "DRONE SCANNING ZONE " + zone + "...";
  $("scanOverlay").classList.remove("hidden");
  $("scanMessage").textContent = "Scanning zone " + zone + "...";

  // Take several colour readings during the scan and average them.
  const readings = [];
  const endTime = Date.now() + SETTINGS.scanSeconds * 1000;
  while (Date.now() < endTime) {
    if (grabFrame()) readings.push(analyseColours(true));
    await sleep(250);
  }

  grabFrame();
  const ai = await classify();
  const result = decideResult(averageReadings(readings), ai);
  result.photo = captureCanvas.toDataURL("image/jpeg", 0.7);   // small photo for the details panel
  results[zone] = result;
  saveResults();

  $("scanOverlay").classList.add("hidden");
  busy = false;

  showZoneDetail(zone);
  goToNextZone();
  drawEverything();
}

// Moves the selection to the next zone that has not been scanned yet.
function goToNextZone() {
  for (let step = 1; step <= ZONES.length; step++) {
    const next = (currentZone + step) % ZONES.length;
    if (!results[ZONES[next]]) {
      currentZone = next;
      $("scanMessage").textContent = "Done. Move the drone to zone " + ZONES[next] + ".";
      return;
    }
  }
  $("scanMessage").textContent = "Field scan complete. See the summary below.";
}

// Whole-field view: the camera sees the whole tray at once.
// The picture is cut into 3 x 3 squares and every square is analysed as one zone.
// A real drone does the same with a photo taken from high up.
async function scanWholeField() {
  if (busy) return;
  if (!grabFrame()) {
    $("scanMessage").textContent = "No picture yet. Start the camera or upload a photo first.";
    return;
  }

  busy = true;
  setButtons();
  $("scanText").textContent = "DRONE SCANNING WHOLE FIELD...";
  $("scanOverlay").classList.remove("hidden");
  $("scanMessage").textContent = "Scanning all 9 zones...";

  // Several colour readings for every zone, averaged at the end.
  const readings = ZONES.map(() => []);
  const endTime = Date.now() + SETTINGS.scanSeconds * 1000;
  while (Date.now() < endTime) {
    for (let cell = 0; cell < ZONES.length; cell++) {
      if (grabFrame(cell)) readings[cell].push(analyseColours(false));
    }
    await sleep(250);
  }

  for (let cell = 0; cell < ZONES.length; cell++) {
    grabFrame(cell);
    const ai = await classify();
    const result = decideResult(averageReadings(readings[cell]), ai);
    result.photo = captureCanvas.toDataURL("image/jpeg", 0.7);
    results[ZONES[cell]] = result;
  }
  saveResults();

  $("scanOverlay").classList.add("hidden");
  busy = false;

  // Show the details of the first zone that has a problem (or A1 if all are fine).
  const firstProblem = ZONES.findIndex((z) => results[z].status === "warning" || results[z].status === "critical");
  currentZone = firstProblem === -1 ? 0 : firstProblem;
  showZoneDetail(ZONES[currentZone]);
  $("scanMessage").textContent = "Whole field scanned. Tap a zone to see its details.";
  drawEverything();
}

// Switches the whole-field view on or off.
function toggleFieldView() {
  fieldView = !fieldView;
  $("fieldOverlay").classList.toggle("hidden", !fieldView);
  $("scanMessage").textContent = fieldView
    ? "Hold the camera high so the whole tray fits the grid on the camera picture."
    : "";
  setButtons();
}

function allZonesScanned() {
  return ZONES.every((zone) => results[zone]);
}

// Auto-scan: countdown, scan, move on, until every zone is done.
async function toggleAutoScan() {
  if (autoRunning) { autoRunning = false; return; }   // pressing again stops it

  if (allZonesScanned()) {
    $("scanMessage").textContent = "All zones are scanned. Press Reset field to scan again.";
    return;
  }
  if (!grabFrame()) {
    $("scanMessage").textContent = "No picture yet. Start the camera or upload a photo first.";
    return;
  }

  autoRunning = true;
  setButtons();

  while (autoRunning && !allZonesScanned()) {
    if (results[ZONES[currentZone]]) goToNextZone();
    drawGrid();
    for (let seconds = SETTINGS.autoCountdown; seconds > 0 && autoRunning; seconds--) {
      $("scanMessage").textContent =
        "Move the drone to zone " + ZONES[currentZone] + " - scanning in " + seconds + "...";
      await sleep(1000);
    }
    if (autoRunning) await scanZone();
  }

  autoRunning = false;
  if (!allZonesScanned()) $("scanMessage").textContent = "Auto-scan stopped.";
  setButtons();
}

function setButtons() {
  $("scanBtn").textContent = fieldView ? "Scan whole field" : "Scan zone " + ZONES[currentZone];
  $("scanBtn").disabled = busy || autoRunning;
  $("autoBtn").textContent = autoRunning ? "Stop auto-scan" : "Start auto-scan";
  $("autoBtn").disabled = fieldView || busy && !autoRunning;
  $("fieldViewBtn").textContent = "Whole-field view: " + (fieldView ? "ON" : "OFF");
  $("fieldViewBtn").disabled = busy || autoRunning;
  $("demoBtn").disabled = busy || autoRunning;
  $("resetBtn").disabled = busy || autoRunning;
}


/* ========================= 9. DRAWING THE PAGE ========================= */

function drawEverything() {
  drawGrid();
  drawSummary();
  setButtons();
  $("demoBanner").classList.toggle("hidden", !ZONES.some((z) => results[z] && results[z].demo));
}

// The 3 x 3 field map.
function drawGrid() {
  const grid = $("fieldGrid");
  grid.innerHTML = "";

  ZONES.forEach((zone, index) => {
    const result = results[zone];
    const cell = document.createElement("button");
    cell.className = "zone " + (result ? result.status : "") + (index === currentZone ? " current" : "");

    let html = '<span class="zone-name">' + zone + "</span>";
    if (!result) {
      html += '<span class="zone-type">not scanned</span>';
    } else if (result.status === "empty") {
      html += '<span class="zone-type">No plant</span>';
    } else {
      html += '<span class="zone-score">' + result.health + "%</span>";
      html += '<span class="zone-type">' + safe(problemLabel(result)) + "</span>";
    }
    cell.innerHTML = html;

    // Tapping a zone selects it (to scan or re-scan) and shows its details.
    cell.onclick = () => {
      if (busy || autoRunning) return;
      currentZone = index;
      showZoneDetail(zone);
      drawEverything();
    };
    grid.appendChild(cell);
  });
}

// Details and advice for one zone.
function showZoneDetail(zone) {
  const result = results[zone];
  const box = $("zoneDetail");

  if (!result) {
    box.textContent = "Zone " + zone + " has not been scanned yet.";
    return;
  }

  const lines = [];
  if (result.status !== "empty") {
    lines.push("Leaf health: <b>" + result.health + "%</b> (yellow " + result.yellowPercent +
      "%, brown " + result.brownPercent + "%)");
    lines.push("Problem type: <b>" + safe(problemLabel(result)) + "</b> (decided by " +
      (result.decidedBy === "AI" ? "the AI model" : "colour analysis") + ")");
  }
  if (result.aiClass) {
    lines.push("AI model says: " + safe(result.aiClass) + ", " + result.aiConfidence + "% sure");
  } else if (!result.demo) {
    lines.push("AI model: not loaded for this scan");
  }
  if (result.demo) lines.push("<i>Sample result (demo mode)</i>");

  box.innerHTML =
    (result.photo ? '<img src="' + result.photo + '" alt="Photo of zone ' + zone + '">' : "") +
    '<div class="detail-text">' +
      '<div class="detail-title text-' + result.status + '">Zone ' + zone + " - " +
        STATUS_LABELS[result.status] + "</div>" +
      lines.map((line) => "<div>" + line + "</div>").join("") +
      '<div class="advice"><b>Suggested action:</b> ' + PROBLEMS[result.problem].advice + "</div>" +
    "</div>";
}

// The summary panel.
function drawSummary() {
  const scanned = ZONES.filter((zone) => results[zone]);
  const withPlants = scanned.filter((zone) => results[zone].status !== "empty");
  const healthy = withPlants.filter((zone) => results[zone].status === "healthy");
  const affected = withPlants.filter((zone) => results[zone].status !== "healthy");

  // Overall health = the average of the scores of all zones that have a plant.
  let average = null;
  if (withPlants.length > 0) {
    let sum = 0;
    withPlants.forEach((zone) => { sum += results[zone].health; });
    average = Math.round(sum / withPlants.length);
  }

  $("sumHealth").textContent = average === null ? "--" : average + "%";
  $("sumHealth").className = "big-number" + (average === null ? "" : " text-" + statusFromScore(average));
  $("sumHealthy").textContent = healthy.length;
  $("sumAffected").textContent = affected.length;
  $("sumScanned").textContent = scanned.length + "/" + ZONES.length;

  const list = $("attentionList");
  if (scanned.length === 0) {
    list.textContent = "Nothing scanned yet.";
  } else if (affected.length === 0) {
    list.textContent = "No zones need attention so far.";
  } else {
    list.innerHTML = affected.map((zone) => {
      const r = results[zone];
      return '<div class="attention-item ' + r.status + '"><b>Zone ' + zone + " - " +
        STATUS_LABELS[r.status] + " (" + r.health + "%) - " + safe(problemLabel(r)) + "</b><br>" +
        PROBLEMS[r.problem].advice + "</div>";
    }).join("");
  }
}


/* ============ 10. DEMO MODE, SAVING, SETTINGS, START-UP ============ */

// Demo mode: sample results in case the camera and upload both fail.
function loadDemo() {
  const samples = [
    ["A1", 92, "healthy"], ["A2", 88, "healthy"], ["A3", 61, "yellowing"],
    ["B1", 95, "healthy"], ["B2", 34, "brown"],   ["B3", 83, "healthy"],
    ["C1", 55, "yellowing"], ["C2", 22, "dry"],   ["C3", 90, "healthy"]
  ];
  results = {};
  samples.forEach(([zone, health, problem]) => {
    results[zone] = {
      health: health,
      status: statusFromScore(health),
      problem: problem,
      decidedBy: "colour",
      yellowPercent: problem === "yellowing" ? 100 - health : 0,
      brownPercent: problem === "brown" || problem === "dry" ? 100 - health : 0,
      aiClass: null,
      aiConfidence: null,
      demo: true
    };
  });
  currentZone = 0;
  saveResults();
  $("scanMessage").textContent = "Demo data loaded. Press Reset field to clear it.";
  showZoneDetail("A1");
  drawEverything();
}

function resetField() {
  if (!confirm("Clear all scanned zones?")) return;
  results = {};
  currentZone = 0;
  saveResults();
  $("zoneDetail").textContent = "Scan a zone to see its result here.";
  $("scanMessage").textContent = "";
  drawEverything();
}

// Results are kept in the browser, so refreshing the page does not lose the map.
function saveResults() {
  try { localStorage.setItem("cropResults", JSON.stringify(results)); } catch (error) { /* storage full or blocked */ }
}
function saveSettings() {
  try { localStorage.setItem("cropSettings", JSON.stringify(SETTINGS)); } catch (error) { /* ignore */ }
}
function loadSaved() {
  try {
    Object.assign(SETTINGS, JSON.parse(localStorage.getItem("cropSettings")) || {});
    results = JSON.parse(localStorage.getItem("cropResults")) || {};
  } catch (error) {
    results = {};
  }
  const firstEmpty = ZONES.findIndex((zone) => !results[zone]);
  currentZone = firstEmpty === -1 ? 0 : firstEmpty;
}

// Connects one slider in Settings to one number in SETTINGS.
function connectSlider(name) {
  const slider = $(name);
  slider.value = SETTINGS[name];
  $(name + "Val").textContent = SETTINGS[name];
  slider.oninput = () => {
    SETTINGS[name] = Number(slider.value);
    $(name + "Val").textContent = SETTINGS[name];
    saveSettings();
  };
}

function showOnlineStatus() {
  $("onlineStatus").textContent = navigator.onLine ? "" : "Offline mode";
}

// ---- Start-up: runs once when the page opens ----
function start() {
  loadSaved();
  ["healthyAbove", "warningAbove", "bgTolerance", "autoCountdown"].forEach(connectSlider);

  $("startCameraBtn").onclick = () => startCamera();
  $("cameraSelect").onchange = (event) => startCamera(event.target.value);
  $("uploadInput").onchange = (event) => { useUploadedPhoto(event.target.files[0]); event.target.value = ""; };
  $("modelFilesInput").onchange = (event) => loadModelFromFiles(event.target.files);
  $("scanBtn").onclick = () => (fieldView ? scanWholeField() : scanZone());
  $("fieldViewBtn").onclick = toggleFieldView;

  // The 3 x 3 guide grid drawn over the camera picture in whole-field view.
  ZONES.forEach((zone) => {
    const guide = document.createElement("span");
    guide.textContent = zone;
    $("fieldOverlay").appendChild(guide);
  });
  $("autoBtn").onclick = toggleAutoScan;
  $("demoBtn").onclick = loadDemo;
  $("resetBtn").onclick = resetField;

  window.addEventListener("online", showOnlineStatus);
  window.addEventListener("offline", showOnlineStatus);
  showOnlineStatus();

  drawEverything();
  loadModel();
  setInterval(updateLive, 500);   // live reading, twice a second

  // The service worker (sw.js) saves the files so the page works without internet.
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch((error) => console.error(error));
  }
}

start();
