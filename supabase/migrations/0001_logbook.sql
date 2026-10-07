-- ScopePilot student logbook, slice 1: experiments, per-user daily usage, image bucket.
-- Apply once in the Supabase dashboard SQL editor (see docs/HANDOFF.md, "Student logbook").
--
-- Access model: the app talks to Supabase only for Auth (publishable key). Tables and the
-- bucket have row-level security enabled with NO policies for anon/authenticated, so the
-- publishable key cannot read or write them. Only the backend, using the secret key
-- (service_role, which bypasses RLS), touches this data, and it scopes every query by user.

create table public.experiments (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    status text not null default 'draft' check (status in ('draft', 'saved')),
    title text check (char_length(title) between 1 and 120),
    notes text not null default '' check (char_length(notes) <= 5000),
    analysis jsonb not null,
    model text not null,
    prompt_version text not null,
    image_path text not null,
    thumb_path text not null,
    image_bytes integer not null check (image_bytes > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    saved_at timestamptz,
    expires_at timestamptz,
    constraint saved_has_title check (status = 'draft' or title is not null),
    -- Saving a draft must set status='saved', saved_at=now() and expires_at=null in a single UPDATE.
    constraint draft_expiry check ((status = 'draft') = (expires_at is not null)),
    constraint analysis_size check (octet_length(analysis::text) <= 100000)
);

create index experiments_user_status_created_idx
    on public.experiments (user_id, status, created_at desc);
create index experiments_draft_expiry_idx
    on public.experiments (expires_at) where status = 'draft';

create function public.set_updated_at() returns trigger
    language plpgsql
    set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger experiments_set_updated_at
    before update on public.experiments
    for each row execute function public.set_updated_at();

create table public.usage_daily (
    user_id uuid not null references auth.users (id) on delete cascade,
    day date not null,
    gemini_calls integer not null default 0 check (gemini_calls >= 0),
    primary key (user_id, day)
);

alter table public.experiments enable row level security;
alter table public.usage_daily enable row level security;
-- No policies on purpose (deny-all for anon/authenticated); revoke grants as a second layer.
revoke all on public.experiments from anon, authenticated;
revoke all on public.usage_daily from anon, authenticated;
grant all on public.experiments, public.usage_daily to service_role;

-- Atomically takes one Gemini call from the user's quota for the current UTC day.
-- Returns false, without incrementing, once the limit is reached. Backend only.
create function public.consume_gemini_call(p_user uuid, p_limit integer) returns boolean
    language plpgsql
    security definer
    set search_path = ''
as $$
declare
    taken integer;
begin
    if p_limit <= 0 then
        return false;
    end if;
    insert into public.usage_daily as u (user_id, day, gemini_calls)
    values (p_user, (now() at time zone 'utc')::date, 1)
    on conflict (user_id, day) do update
        set gemini_calls = u.gemini_calls + 1
        where u.gemini_calls < p_limit
    returning u.gemini_calls into taken;
    return taken is not null and taken <= p_limit;
end;
$$;

revoke all on function public.consume_gemini_call(uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_gemini_call(uuid, integer) to service_role;
revoke all on function public.set_updated_at() from public, anon, authenticated;

-- Private bucket for metadata-free display copies: {user_id}/{experiment_id}/image.jpg and thumb.jpg.
-- No storage.objects policies are added, so only the secret key can read or write it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('experiment-images', 'experiment-images', false, 3145728, array['image/jpeg'])
on conflict (id) do nothing;
