create table auth_codes (
    code text primary key,
    redirect_uri text not null,
    code_challenge text,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

-- Index for expiry-based lookups
create index idx_auth_codes_expires_at on auth_codes (expires_at);
