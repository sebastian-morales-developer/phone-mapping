# Phone Mapping Webapp V1

Local web application for uploading house photos, creating a project, running the photo-editing pipeline, and generating a 3D GLB model.

## Start The App

Run this in WSL Ubuntu:

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

If you need to close any previous local server:

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

## Environment Variables

The `.env` file must exist in the project root and include:

```text
OPENAI_API_KEY=...
3DAISTUDIO_API_KEY=...
```

## Cloudflare Tunnel

Use this when you want to access the local app from another device, for example from a phone.

First, start the local app in one WSL terminal:

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

Then open a temporary tunnel to `localhost:3000`:

```bash
cloudflared tunnel --url http://localhost:3000
```

Cloudflare will print a temporary URL similar to:

```text
https://example-random-name.trycloudflare.com
```

Open that URL from your phone or another device. Keep both terminals running while using the app:

```text
Terminal 1: npm run dev
Terminal 2: cloudflared tunnel --url http://localhost:3000
```
