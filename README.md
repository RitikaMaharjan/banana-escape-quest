# Banana Escape Room 

A timed escape-room game: open 3 locks within 3 minutes by solving puzzles from the Banana API.

## Run
1. `cd backend`
2. `npm install`
3. Create `backend/.env` with `PORT`, `SESSION_SECRET` and `BANANA_API_URL`
4. `npm run dev`, then open http://localhost:3000

## Features
Register and log in, a 3-minute timer, hints, a leaderboard, and sound with a mute button.

## Structure
- `frontend/`: HTML, CSS and browser JavaScript
- `backend/src/`: Express API (routes, controllers, services, middleware, SQLite)

## Four themes
- Version control: Git history, tags and branches
- Event-driven: click, keyboard and timer events in the browser, HTTP requests on the server
- Interoperability: `services/bananaService.js` calls the Banana API over HTTPS (JSON)
- Virtual identity: bcrypt password hashing, session cookies, protected routes, per-player scores

## Sources and acknowledgements
- Banana API: https://marcconrad.com/uob/banana/doc.php
- AI assistance (Claude, Anthropic): timer, scoring, hints, leaderboard, sound, rate limiting, duplicate-puzzle check and the page styling. Files are marked "AI-assisted" at the top.
