create table oauth_tokens (
    token text primary key,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

-- Index for expiry-based lookups
create index idx_oauth_tokens_expires_at on oauth_tokens (expires_at);
