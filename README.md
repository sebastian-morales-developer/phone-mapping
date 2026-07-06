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
```

Use `.env.example` as the safe template. It contains only the variable names and no secrets.

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

You choose the 3D provider, then drag each photo into the correct view slot. The original file name does not matter in individual mode because the selected slot defines the view label.

### Batch Production

Use this mode to upload a ZIP package with one subfolder per project.

Each subfolder must include a `phone_mapping_project.json` file:

```json
{
  "model_provider": "tencent",
  "projectTitle": "Optional project title"
}
```

The model provider must be either:

```text
tencent
hyper3d
```

### Batch Production Two Models

Use this mode to test both providers automatically from a ZIP package.

Each subfolder only needs named images. No `phone_mapping_project.json` is required. The app uses the subfolder name as the project title.

For Tencent, the app selects compatible Tencent views and can test the original or inverted orientation to maximize usable views.

For Hyper3D, the app can select up to five views from the available images. When there are more than five candidate images, the pipeline can use OpenAI image analysis to choose the best set.

## Supported Views

### Tencent Hunyuan 3.1 through 3D AI Studio

Tencent supports up to six view slots in this app:

```text
front
left_front
right_front
left
right
back
```

This provider can work with fewer images, but the final model quality depends heavily on how complete and coherent the available views are.

### Hyper3D Rodin Gen-2.5

Hyper3D supports up to five uploaded images, selected from eight possible angles:

```text
front
left_front
left
back_left
back
back_right
right
right_front
```

This is useful when the available photos cover diagonal/back angles, but only five images can be sent to the provider.

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
2. Click `Set Reference Scale`.
3. Select an orthophoto.
4. Draw a measurement line over a known real-world reference, for example a door height.
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
