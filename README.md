# Collaborative Home

Household coordination app for neurodivergent couples and roommates. A standards gap between housemates is inevitable — this app doesn't eliminate it, it helps people find a landing spot both can live with.

- Shared household account, individual profiles per person, no one is the "house manager."
- Onboarding: each person privately rates their comfort level across shared-space categories (Kitchen, Bathroom, Common Areas, Laundry). Once everyone in the household has rated a category, the standard is set to the average — locked, visible to all, owned by no one.
- Shared task dashboard: everyone can see what's done and what isn't. No approval step, no grading.
- Weekly check-in: rate how each standard is actually feeling. A low rating flags that category for renegotiation.

## Stack

Vanilla HTML/CSS/JS frontend (`public/index.html`) served by a Node/Express backend (`server.js`), PostgreSQL for storage, deployed on Railway from this repo's `main` branch.

## Local development

```
npm install
cp .env.example .env   # fill in DATABASE_URL and JWT_SECRET
npm start
```

Requires a Postgres database — `DATABASE_URL` is a standard `postgresql://` connection string. Tables are created automatically on boot if they don't exist.

## API

All endpoints are under `/api`. Auth is a Bearer JWT returned by household creation, joining, or login.

- `POST /api/households` — create a household + first member
- `POST /api/households/join` — join an existing household via invite code
- `POST /api/auth/login`
- `GET /api/me` — current user, household, and members
- `GET /api/categories` — the shared-space categories and their rating-scale copy
- `POST /api/standards/ratings` — submit your own per-category ratings; standards lock automatically once everyone has rated a category
- `GET /api/standards` — current locked standards + everyone's underlying ratings
- `GET/POST /api/tasks`, `PUT /api/tasks/:id/toggle`, `DELETE /api/tasks/:id`
- `POST /api/checkins` — weekly satisfaction ratings per category
- `GET /api/checkins/needs-attention` — categories flagged for renegotiation this week
