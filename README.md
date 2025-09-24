# ChatCall – WhatsApp‑like Video Call (Express + EJS + MongoDB + Socket.IO + WebRTC)

A production‑style Node.js app with Client/Agency roles, login/register, online presence, and WebRTC video calls using Socket.IO for signaling.

## Local Development

1. Install deps
```
npm install
```

2. Create `.env`
```
PORT=3000
MONGO_URI=mongodb://127.0.0.1:27017/whatsapp_videocall
SESSION_SECRET=supersecret_change_me
```

3. Start MongoDB locally (Windows service or `mongod`)

4. Start the server
```
npm run dev
```
Visit http://localhost:3000

## Project Structure
```
server.js
routes/ controllers/ models/ utils/
views/ (EJS)
public/ (css/js/images)
```

## Production Deployment (Recommended: Render/Railway/Fly)
This app is a long‑running Express server with Socket.IO (WebSockets). Platforms with persistent Node processes are recommended.

### Render (free tier friendly)
1. Push to GitHub (see Git commands below)
2. In Render Dashboard → New → Web Service → Connect your repo
3. Environment
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `node server.js`
4. Add Environment Variables
   - `PORT` will be set by Render automatically; in `server.js` we read `process.env.PORT`.
   - `MONGO_URI` → e.g. an Atlas connection string or a managed Mongo service
   - `SESSION_SECRET` → any strong string
5. Deploy. After it’s live, your URL will look like `https://your-app.onrender.com`

### Railway
1. Create a New Project → Deploy from GitHub repo
2. Add variables `MONGO_URI`, `SESSION_SECRET`
3. Start command: `node server.js`

### Fly.io / Docker (optional)
- Add a `Dockerfile`, build & deploy a long‑running container. (Ask and I’ll provide a Dockerfile.)

## About Vercel
Vercel’s Serverless/Edge runtimes are not designed for running a traditional Express + Socket.IO server with long‑lived WebSocket connections. You can:
- Either migrate to Next.js with Vercel’s WebSocket support (Edge runtime), or
- Keep this code and deploy to a platform that supports persistent Node servers (Render/Railway/Fly.io). 

If you still want Vercel for the frontend, you can:
- Host a static frontend on Vercel
- Run this Express/Socket.IO server on Render (or similar)
- Point the frontend to the Render signaling server URL

I can help wire this split deployment if needed.

## Git: Initialize and Push to GitHub
From the project root:
```
# 1) Initialize repo
git init

# 2) Add files and commit (README is optional; .gitignore already added)
echo "# ChatCall" > README.md
git add .
git commit -m "first commit"

# 3) Set default branch to main
git branch -M main

# 4) Add your remote (replace with your repo URL)
git remote add origin https://github.com/<your-username>/videocall.git

# 5) Push
git push -u origin main
```

Note: `.env` is in `.gitignore` so your secrets are not committed. Set them in your hosting provider’s dashboard.

## Environment Variables
- `PORT` – Port to listen on (hosting usually sets this)
- `MONGO_URI` – MongoDB connection string
- `SESSION_SECRET` – Secret used by `express-session`

## Troubleshooting
- If the call fails to start: ensure camera/mic permissions are granted.
- If running both peers on one machine, the webcam may be exclusive to one process. Use two different browsers (Chrome + Edge/Firefox) or a virtual camera.
- On the internet (NATs/Firewalls), consider adding a TURN service for better connectivity. I can add TURN configuration.
