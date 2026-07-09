# Phone Mapping Webapp V1

Phone Mapping is a local web application that turns labeled house photos into a 3D GLB model, renders orthophotos, and extracts early measurement estimates from the generated geometry.

The app uses a Node.js backend, a plain HTML/CSS/JavaScript frontend, and Python microservices for image cleanup, 3D generation, orthophoto rendering, and measurement processing.

## Main Capabilities

- Upload labeled property photos from different angles.
- Clean input photos with OpenAI image editing.
- Generate GLB models using either Tencent Hunyuan through 3D AI Studio or Hyper3D Rodin Gen-2.5.
- Render orthophotos from the GLB model.
- Set a manual reference scale on an orthophoto.
- Estimate building footprint dimensions and visible top/roof areas.
- Add project titles and comments.
- Export project comments and project summaries as JSON.
- Run single-project production or batch production.

## Project Structure

```text
phone_mapping_webapp_v1/
  backend/
    server.js
  frontend/
    index.html
    viewer.html
    orthophotos.html
    css/
    js/
    images/
    logos/
  python_services/
  projects/
  batch_uploads/
  package.json
  requirements-orthophotos.txt
  .env
  .env.example
```

## Requirements

- WSL Ubuntu.
- Node.js installed through `nvm` or available in PATH.
- Python virtual environment.
- Google Chrome or Microsoft Edge installed locally for orthophoto rendering.
- API keys for the providers used by the pipeline.

## Environment Variables

Create a `.env` file in the project root:

```text
OPENAI_API_KEY=your_openai_key
HYPER3D_API_KEY=your_hyper3d_key
API_KEY_3DAISTUDIO=your_3daistudio_key
PROJECTS_PATH=projects
```

Use `.env.example` as the safe template. It contains only the variable names and no secrets.

`PROJECTS_PATH=projects` means the app will store and read generated projects from the `projects/` folder inside the app root. This can be changed in another server if project assets need to live in a different folder.

## Install Node Dependencies

Run this from WSL Ubuntu:

```bash
cd ~/projects/phone_mapping_webapp_v1
export PATH="/home/usuario/.nvm/versions/node/v24.18.0/bin:$PATH"
npm install
```

This installs the dependencies defined in `package.json`, including Express, Multer, dotenv, CORS, Morgan, and Nodemon.

## Install Python Dependencies

If the virtual environment does not exist yet:

```bash
cd ~/projects/phone_mapping_webapp_v1
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements-orthophotos.txt
```

If the virtual environment already exists:

```bash
cd ~/projects/phone_mapping_webapp_v1
source .venv/bin/activate
pip install -r requirements-orthophotos.txt
```

## Start The App

```bash
cd ~/projects/phone_mapping_webapp_v1
export PATH="/home/usuario/.nvm/versions/node/v24.18.0/bin:$PATH"
npm run dev
```

Then open:

```text
http://localhost:3000
```

## Stop The App

```bash
pkill -f "nodemon backend/server.js"
pkill -f "node backend/server.js"
```

## Clean Restart

```bash
pkill -f "nodemon backend/server.js"
pkill -f "node backend/server.js"

cd ~/projects/phone_mapping_webapp_v1
export PATH="/home/usuario/.nvm/versions/node/v24.18.0/bin:$PATH"
npm run dev
```

## Projects Folder

The `projects/` folder stores all generated project outputs.

When the app starts for the first time, this folder may be empty. New projects are created automatically as:

```text
projects/project_1/
projects/project_2/
projects/project_3/
```

Each project usually contains:

```text
project_N/
  input_photos/
  output_photos/
    edited/
    comparison/
    orthophotos/
  output_glb/
  measurements/
  logs/
  project_manifest.json
```

If you need to import existing generated projects from another machine or backup, copy the complete `project_N` folders into `projects/`. The app reads the project metadata from each folder.

## Production Modes

### Individual Production

Use this mode to create one project manually.

You choose the 3D provider, choose the image source, then drag each photo into the correct view slot. The original file name does not matter in individual mode because the selected slot defines the view label.

Available 3D providers:

- `Tencent Hunyuan 3.1`: 3D AI Studio multiview workflow.
- `Hyper3D Rodin Gen-2.5`: Hyper3D multiview workflow.

Available image sources:

- `AI-cleaned images`: the app first sends the uploaded photos through OpenAI image editing to remove obstacles or visual clutter, then sends the cleaned images to the selected 3D provider.
- `Original images`: the app skips OpenAI cleanup and sends the selected original images directly to the selected 3D provider.

### Batch Production By Model

Use this mode to upload a ZIP package with one subfolder per project. The selected provider and selected image source apply to every subfolder in the ZIP.

Each subfolder should contain named images such as:

```text
project_folder/front.jpg
project_folder/top.jpg
project_folder/left_front.jpg
project_folder/right.jpg
```

No `phone_mapping_project.json` is required for this mode. The app uses each subfolder name as the project title.

The same provider rules used in Individual Production are applied to every subfolder.

## 3D Provider API References

The app currently uses these exact 3D generation models:

- `Hyper3D Rodin Gen-2.5`: `Gen-2.5 Generation` API.
  Documentation: https://developer.hyper3d.ai/api-specification/rodin-gen2.5
- `Tencent Hunyuan 3.1`: 3D AI Studio Tencent Hunyuan 3D generation API.
  Documentation: https://www.3daistudio.com/Platform/API/Documentation/3d-generation/tencent-hunyuan

## Provider Rules

### Tencent Hunyuan 3.1 Through 3D AI Studio

Tencent accepts up to seven supported views in this app:

```text
top
front
left_front
right_front
left
right
back
```

Rules:

- `front` is required.
- If valid Tencent views are uploaded, the app sends all supported views it can use.
- There is no OpenAI view-selection step for Tencent.
- `back_left` and `back_right` are not sent to Tencent.
- Image cleanup is controlled by the selected image source: `AI-cleaned images` or `Original images`.

### Hyper3D Rodin Gen-2.5

Hyper3D accepts a maximum of five images per generation, selected from nine possible view slots in this app:

```text
top
front
left_front
left
back_left
back
back_right
right
right_front
```

Rules:

- At least one image is required, from any supported angle.
- `front` is not required for Hyper3D.
- If five or fewer images are uploaded, the app uses those images.
- If more than five images are uploaded, the app uses OpenAI image analysis to choose the five images that look most useful for reconstruction.
- Image cleanup is controlled by the selected image source: `AI-cleaned images` or `Original images`.

Special top-only behavior:

If a Hyper3D project is created with only one `top` image, the pipeline applies the custom top-only GLB post-processing step before rendering orthophotos.

## Viewer Page

Open `View 3D` from any completed project. The viewer shows:

- The interactive GLB model.
- Project title and model provider.
- Editable project comments.
- Orthophotos.
- Reference scale output.
- Top visible area estimates.
- Estimated building dimensions.
- Original vs cleaned comparison images.

## Reference Scale Workflow

The reference scale is used to convert image/model dimensions into approximate real-world measurements.

Basic flow:

1. Open a project in the viewer.
2. Click `Set Reference Scale`, or click one of the orthophotos.
3. Select any orthophoto that contains a known real-world reference.
4. Draw a measurement line between two known points, such as the top and bottom of a front door, garage door, entry door, wall segment, or any reference dimension that was measured in the real world.
5. Enter the real measurement in meters.
6. Save the reference scale.

After saving, the app recalculates:

- Front width in meters.
- Building length in meters.
- Estimated footprint area.
- Visible top area estimates.

This is an approximation workflow. Accuracy depends on the quality of the GLB model, the orthophoto, and the reference measurement selected by the user.

## Export JSON

The `Export JSON` button in the Projects panel downloads a structured summary file containing:

- Project names.
- Project titles.
- Model providers.
- Project comments.
- Pipeline status.
- Available GLB outputs.
- Reference scale data when available.
- Measurement estimates when available.

This is useful for reviewing notes and results across many projects.

## Cloudflare Tunnel

Use this when you want to access the local app from another device, for example from a phone.

Start the local app in one WSL terminal:

```bash
cd ~/projects/phone_mapping_webapp_v1
export PATH="/home/usuario/.nvm/versions/node/v24.18.0/bin:$PATH"
npm run dev
```

In a second WSL terminal, install `cloudflared` if needed:

```bash
if ! command -v cloudflared >/dev/null 2>&1; then
  wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -O /tmp/cloudflared.deb
  sudo dpkg -i /tmp/cloudflared.deb
fi
```

Open a temporary tunnel to `localhost:3000`:

```bash
cloudflared tunnel --url http://localhost:3000
```

Cloudflare will print a temporary URL similar to:

```text
https://example-random-name.trycloudflare.com
```

Open that URL from your phone or another device. Keep both terminals running while using the app.

## Notes

- Generated project folders can become large because they include images, GLB files, logs, and measurement outputs.
- API calls can generate real provider costs.
- Do not commit `.env` or generated project outputs unless intentionally needed.
- Use `.env.example` to document required environment variables without exposing secrets.
