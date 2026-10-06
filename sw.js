/* Service worker: makes the app work without internet.
   Rule: try the internet first (so you always get your newest files),
   and if that fails, use the copy saved on the device. */

const CACHE = "crop-monitor-v1";

// Files saved as soon as the app is opened for the first time.
const CORE_FILES = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "icon.svg",
  "libs/tf.min.js",
  "libs/teachablemachine-image.min.js"
];

// The model files are saved too, if they exist (they are added later by you).
const MODEL_FILES = ["model/model.json", "model/metadata.json", "model/weights.bin"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.addAll(CORE_FILES);
      await Promise.all(MODEL_FILES.map((file) => cache.add(file).catch(() => {})));
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Save a fresh copy for next time.
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
