-- Users (replaces Supabase Auth)
CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Meals
CREATE TABLE IF NOT EXISTS meals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    logged_at timestamptz NOT NULL DEFAULT now(),
    meal_type text CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
    description text NOT NULL,
    calories integer,
    protein_g numeric,
    carbs_g numeric,
    fat_g numeric,
    notes text
);

-- OAuth access tokens
CREATE TABLE IF NOT EXISTS oauth_tokens (
    token text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- OAuth authorization codes (short-lived, single-use)
CREATE TABLE IF NOT EXISTS auth_codes (
    code text PRIMARY KEY,
    redirect_uri text NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_challenge text,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Tool analytics
-- user_id is intentionally text (not a FK) so analytics rows survive account deletion
CREATE TABLE IF NOT EXISTS tool_analytics (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    tool_name text NOT NULL,
    success boolean NOT NULL,
    duration_ms integer NOT NULL,
    error_category text,
    date_range_days integer,
    mcp_session_id text,
    invoked_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_analytics_user_id ON tool_analytics(user_id);
CREATE INDEX IF NOT EXISTS idx_tool_analytics_tool_name ON tool_analytics(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_analytics_invoked_at ON tool_analytics(invoked_at);
CREATE INDEX IF NOT EXISTS idx_tool_analytics_user_tool ON tool_analytics(user_id, tool_name);

-- Registered clients (OAuth dynamic client registration log)
CREATE TABLE IF NOT EXISTS registered_clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_name text,
    redirect_uris jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT now()
);
