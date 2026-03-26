# Nutrition MCP

A remote MCP server for personal nutrition tracking — log meals, track macros, and review nutrition history through conversation.

## Quick Start

### Hosted (no setup required)

Already hosted and ready to use — just connect it to your MCP client:

```
https://nutrition-mcp.com/mcp
```

**On Claude.ai:** Customize → Connectors → + → Add custom connector → paste the URL → Connect

On first connect you'll be asked to register with an email and password. Your data persists across reconnections.

## Demo

[![Demo](https://img.youtube.com/vi/Y1EHbfimQ70/maxresdefault.jpg)](https://youtube.com/shorts/Y1EHbfimQ70)

Read the story behind it: [How I Replaced MyFitnessPal and Other Apps with a Single MCP Server](https://medium.com/@akutishevsky/how-i-replaced-myfitnesspal-and-other-apps-with-a-single-mcp-server-56ca5ec7d673)

## Tech Stack

- **Bun** — runtime and package manager (v1.2+)
- **Hono** — HTTP framework
- **MCP SDK** — Model Context Protocol over Streamable HTTP
- **PostgreSQL** — database (self-hosted via Docker)
- **OAuth 2.0** — authentication for Claude.ai connectors

## MCP Tools

| Tool                      | Description                                                |
| ------------------------- | ---------------------------------------------------------- |
| `log_meal`                | Log a meal with description, type, calories, macros, notes |
| `get_meals_today`         | Get all meals logged today                                 |
| `get_meals_by_date`       | Get meals for a specific date (YYYY-MM-DD)                 |
| `get_nutrition_summary`   | Daily nutrition totals for a date range                    |
| `delete_meal`             | Delete a meal by ID                                        |
| `update_meal`             | Update any fields of an existing meal                      |
| `get_meals_by_date_range` | Get meals between two dates (inclusive)                    |
| `delete_account`          | Permanently delete account and all associated data         |

## Self-Hosting with Docker Compose

The easiest way to self-host is with Docker Compose. It starts the app and a PostgreSQL database together and automatically initialises the schema.

### 1. Generate OAuth credentials

```bash
echo "OAUTH_CLIENT_ID=$(openssl rand -hex 16)"
echo "OAUTH_CLIENT_SECRET=$(openssl rand -hex 32)"
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Fill in the generated OAuth credentials and choose a strong `POSTGRES_PASSWORD`:

```
DATABASE_URL=postgres://nutrition:yourpassword@db:5432/nutrition
POSTGRES_PASSWORD=yourpassword
OAUTH_CLIENT_ID=<generated>
OAUTH_CLIENT_SECRET=<generated>
PORT=8080
```

### 3. Start the stack

```bash
docker compose up -d
```

The app will be available at `http://localhost:8080`. The database schema is applied automatically on first start via `init.sql`.

### 4. Connect to your MCP client

Use `http://localhost:8080/mcp` (or your server's public URL) as the Remote MCP Server URL.

---

## Environment Variables

| Variable              | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `DATABASE_URL`        | PostgreSQL connection string                           |
| `OAUTH_CLIENT_ID`     | Random string for OAuth client identification          |
| `OAUTH_CLIENT_SECRET` | Random string for OAuth client authentication          |
| `PORT`                | Server port (default: `8080`)                          |
| `ALLOWED_ORIGINS`     | Comma-separated list of additional allowed CORS origins |

For Docker Compose, also set:

| Variable            | Description                           |
| ------------------- | ------------------------------------- |
| `POSTGRES_PASSWORD` | Password for the PostgreSQL database  |

---

## Development

```bash
bun install
cp .env.example .env   # fill in your credentials
bun run dev             # starts with hot reload on http://localhost:8080
```

You can run a local PostgreSQL with Docker:

```bash
docker run -d \
  --name nutrition-db \
  -e POSTGRES_DB=nutrition \
  -e POSTGRES_USER=nutrition \
  -e POSTGRES_PASSWORD=nutrition \
  -p 5432:5432 \
  -v "$(pwd)/init.sql:/docker-entrypoint-initdb.d/init.sql:ro" \
  postgres:16-alpine
```

Then set `DATABASE_URL=postgres://nutrition:nutrition@localhost:5432/nutrition` in your `.env`.

---

## Connect to Claude.ai

1. Open [Claude.ai](https://claude.ai) and click **Customize**
2. Click **Connectors**, then the **+** button
3. Click **Add custom connector**
4. Fill in:
    - **Name**: Nutrition Tracker
    - **Remote MCP Server URL**: `https://your-domain/mcp`
5. Click **Connect** — sign in or register when prompted
6. After signing in, Claude can use your nutrition tools. If you reconnect later, sign in with the same email and password to keep your data.

---

## API Endpoints

| Endpoint                                      | Description                            |
| --------------------------------------------- | -------------------------------------- |
| `GET /health`                                 | Health check                           |
| `GET /.well-known/oauth-authorization-server` | OAuth metadata discovery               |
| `POST /register`                              | Dynamic client registration            |
| `GET /authorize`                              | OAuth authorization (shows login page) |
| `POST /approve`                               | Login/register handler                 |
| `POST /token`                                 | Token exchange                         |
| `GET /favicon.ico`                            | Server icon                            |
| `ALL /mcp`                                    | MCP endpoint (authenticated)           |

---

## Deploy (standalone Docker)

```bash
docker build -t nutrition-mcp .
docker run -d \
  -p 8080:8080 \
  -e DATABASE_URL=postgres://user:pass@your-db-host:5432/nutrition \
  -e OAUTH_CLIENT_ID=your-client-id \
  -e OAUTH_CLIENT_SECRET=your-client-secret \
  nutrition-mcp
```

---

## License

[MIT](LICENSE)
