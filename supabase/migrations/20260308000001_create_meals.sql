create table meals (
    id uuid primary key default gen_random_uuid(),
    logged_at timestamptz not null default now(),
    meal_type text check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
    description text not null,
    calories integer,
    protein_g numeric,
    carbs_g numeric,
    fat_g numeric,
    notes text
);

-- Index for date-range queries
create index idx_meals_logged_at on meals (logged_at);
