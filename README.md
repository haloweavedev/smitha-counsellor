# Smitha Career AI Advisor (Node.js)

Personalized career chatbot that uses:
- your resume PDF (auto-detected in this folder)
- your `applications.json` advice template
- Neon Postgres for durable application tracking when `DATABASE_URL` is set
- your local `OPENAI_API_KEY` from `.env`

## Run

```bash
npm run dev
```

Then open:

`http://localhost:3010`

Counseller page:

`http://localhost:3010/counseller`

Tracker page:

`http://localhost:3010/tracker`

## Environment variables (`.env`)

Required:

```bash
OPENAI_API_KEY=your_key_here
```

Optional:

```bash
OPENAI_MODEL=gpt-5
PORT=3010
RESUME_PATH=Smitha Sandrina resume.pdf
OPENAI_BASE_URL=https://api.openai.com/v1
DATABASE_URL=postgresql://...
```

Storage behavior:
- If `DATABASE_URL` is set, `/api/applications` uses Postgres (durable).
- If `DATABASE_URL` is missing, it falls back to local `applications.json`.

## API routes

- `GET /api/health` - checks model + context load status
- `GET /api/profile` - returns parsed profile + applications summary
- `GET /api/applications` - returns application entries (Postgres when configured)
- `POST /api/applications` - add a new application
- `PUT /api/applications/:id` - update an application
- `DELETE /api/applications/:id` - delete an application
- `POST /api/chat` - sends a chat message with tailored context
- `POST /api/session/reset` - clears memory for a chat session
