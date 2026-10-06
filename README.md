# Drone Vision - Crop Health Monitor

A web app that looks at crop leaves through a camera, gives each one a health
score, names the likely problem, and builds a colour map of a 3 x 3 field.

At the exhibition a phone or laptop camera stands in for the drone camera.
The same software would run on the video coming from a real drone.

## Files

| File | What it is |
|---|---|
| `index.html` | The page layout |
| `style.css` | Colours, sizes, layout |
| `app.js` | All the logic, with comments |
| `sw.js` | Saves the files so the app works offline |
| `manifest.json`, `icon.svg` | Let the app be installed like a normal app |
| `libs/` | TensorFlow.js and Teachable Machine, stored locally |
| `model/` | Your trained AI model goes here |

## 1. Run it on your laptop

The camera and the AI model only work when the page is opened from a web
address (`http://localhost` or `https://`), not by double-clicking the file.

1. In VS Code, install the extension **Live Server**.
2. Right-click `index.html` and choose **Open with Live Server**.
3. Press **Start camera** and allow the camera.

Without the model the app still works. It says "colour analysis only" at the top.

## 2. Train the AI model (Teachable Machine)

1. Go to <https://teachablemachine.withgoogle.com/train/image> and choose
   **Standard image model**.
2. Make 5 classes with exactly these names:
   - `Healthy`
   - `Yellowing`
   - `Brown spots`
   - `Dry`
   - `No leaf`
3. For each class, hold the leaf on **white paper** and use **Webcam > Hold to
   Record**. Take about 100 to 150 pictures per class.
   - Use several different leaves for each class, not just one.
   - Turn and move the leaf, and change the distance a little.
   - Use the same lighting and the same camera you will use at the stall, if you can.
   - For `No leaf`, record the empty white paper, the empty tray and your hand.
4. Press **Train Model**. Keep the tab open until it finishes.
5. Test it in the Preview on the right with leaves it has not seen before.
6. Press **Export Model**, choose the **Tensorflow.js** tab, select
   **Download**, then **Download my model**.
7. Unzip the download. Copy these three files into the `model` folder:
   `model.json`, `metadata.json`, `weights.bin`.
8. Refresh the page. The top of the page should say **AI model: ready (5 classes)**.

The app matches classes by key word (health, yellow, brown, dry, no leaf), so
small spelling differences in the names are fine.

If the model will not load, open **Settings > Load AI model from files** and
select the three files together.

## 3. Put it online (Vercel)

1. Create a new repository on GitHub and upload everything inside the
   `drone-crop-monitor` folder (including `libs` and `model`).
2. On <https://vercel.com>, choose **Add New > Project** and import the repository.
3. Leave every setting as it is (Framework: Other) and press **Deploy**.
4. Open the link on your phone and laptop.

Each time you change a file (for example a new model), upload it to GitHub
again and Vercel updates the site by itself.

## 4. Install it and use it offline

- **Phone (Chrome):** open the link, menu (three dots) > **Add to Home screen** / **Install app**.
- **Laptop (Chrome or Edge):** open the link, press the install icon in the address bar.

What needs internet:

- **The first visit** on each device, to download the app and the model.
- **Training** the model on Teachable Machine.
- **Nothing else.** After the first visit the app, the libraries and the model
  are saved on the device.

Before demo day: open the site once on each device with internet, wait until it
says "AI model: ready", then turn on aeroplane mode and reload to check it still works.

## 5. Demo day

1. Lay the 9 plants or leaves on white paper in a 3 x 3 grid (A1 to C3).
2. Press **Start camera**. Hold the camera above zone A1 so the leaf fills most of the square.
3. Press **Scan zone A1**. The app moves on to A2 by itself.
4. Or press **Start auto-scan** and just move the camera when the countdown tells you to.
5. Tap any square to see its details, or to scan it again.

**Whole-field view (no selecting):** press **Whole-field view** so it says ON.
A 3 x 3 grid appears on the camera picture. Hold the camera high above the tray
so each plant sits inside its own square, then press **Scan whole field**. All
9 zones are scanned from that one picture. Keep the tray edges lined up with
the grid and keep the camera steady for the 2 seconds.

If something goes wrong:

- Camera fails: use **Upload photo** (keep 9 leaf photos ready on the device).
- Everything fails: press **Demo mode**. It shows sample results and labels them as demo data.
- White paper shows as yellow or brown in "What the computer sees": open
  **Settings** and increase **Background removal strength**.

## 6. How it works (to explain to the judges)

**Health score.** A picture is made of pixels. For every pixel the program
checks its colour. Pixels with almost no colour (white paper, shadows) are
thrown away as background. The rest are leaf pixels, and each is counted as
green, yellow or brown. The score is green pixels divided by all leaf pixels.
So 82% means 82% of the leaf is still green.

**How it tells colours apart.** It converts each pixel from RGB to HSV. "Hue"
is the colour as an angle on a colour wheel: about 120 is green, 60 is yellow,
30 is brown. "Saturation" is how strong the colour is, which is how we separate
a leaf from white paper.

**Problem type (the AI part).** We trained an image classifier on Teachable
Machine with our own leaf photos. It is a neural network that learned what
healthy, yellowing, brown-spotted and dry leaves look like. It gives a class and
how sure it is. We only trust it when it is at least 60% sure. Otherwise the
program uses the colours.

**Why both?** The colour score is a simple measurement that we can fully
explain. The AI can recognise patterns such as spots that a simple colour count
can miss. If the AI is confident there is a problem but the colour score looks
fine, the zone is marked Warning.

**Field map.** The field is split into 9 zones. Each scan takes several
readings over 2 seconds and averages them, so one shaky frame does not change
the result. Above 75% is green, 40 to 75% is yellow, below 40% is red.

**Whole-field view.** The camera sees the whole tray in one picture. The
program cuts that picture into 9 equal squares and runs the same health check
on each square. A real drone does the same thing with a photo taken from high
up, and uses GPS to know where on the farm each square is. Our phone has no
GPS position over a tray, so we line the tray up with the grid on the screen.

**Advice.** Each problem type has a suggested action. These are suggestions:
the system sees that a leaf looks unhealthy, but yellow leaves can have several
causes, so a farmer still has to check.

**Summary.** Overall field health is the average of all zones that have a
plant. The time chart uses rough estimates, not our own measurements.

**On a real drone.** The drone would fly a planned path and use GPS to know
which zone each picture belongs to. The picture analysis would be the same.

**Honest limits.** Lighting changes colours. It needs a plain background. The
model was trained on few photos of our own leaves. A real system would use
thousands of photos and often a special camera that sees near-infrared light.
