-- ScopePilot RAG: reference passages for POST /v1/experiments/{id}/ask.
-- Apply once in the Supabase dashboard SQL editor, after 0002_logbook_caps.sql.
--
-- Access model as in 0001: row-level security on with NO policies, grants revoked from
-- anon/authenticated, so the app's publishable key cannot read or write the table. Only the
-- backend (service_role, secret key) reads it at ask time and writes it from the ingestion
-- script. The rows are openly licensed biology text, not user data, and hold no user ids.
-- Passages explain biology in general; they are never evidence about a student's image.
-- No vector index: at this size an exact scan is fast and exact.

create extension if not exists vector with schema extensions;

create table public.rag_chunks (
    id uuid primary key default gen_random_uuid(),
    source_key text not null check (source_key ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
    title text not null check (char_length(title) between 1 and 200),
    -- Null for text before the first heading.
    section text check (char_length(section) between 1 and 300),
    url text not null check (url ~ '^https://' and char_length(url) <= 2000),
    licence text not null check (licence ~ '^CC BY(-SA)? (2\.0|2\.5|3\.0|4\.0)$'),
    topic text not null check (topic ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
    content text not null check (char_length(content) between 1 and 4000),
    -- sha256 of the chunk's text, metadata and embedding model (backend/rag/ingest.py).
    content_hash text not null unique check (content_hash ~ '^[0-9a-f]{64}$'),
    embedding_model text not null check (char_length(embedding_model) between 1 and 100),
    embedding extensions.vector(768) not null,
    created_at timestamptz not null default now()
);

create index rag_chunks_source_key_idx on public.rag_chunks (source_key);

alter table public.rag_chunks enable row level security;
-- No policies on purpose (deny-all for anon/authenticated); revoke grants as a second layer.
-- service_role is revoked too, so only the grant below applies whatever the default privileges.
revoke all on public.rag_chunks from anon, authenticated, service_role;
grant select, insert, delete on public.rag_chunks to service_role;

-- The match_count passages closest to query_embedding by cosine distance whose similarity
-- (1 - distance) is at least min_similarity, closest first. match_count is clamped to 0-20;
-- a missing argument returns nothing. Backend only.
create function public.match_rag_chunks(
    query_embedding extensions.vector(768),
    match_count integer,
    min_similarity double precision
) returns table (
    id uuid,
    source_key text,
    title text,
    section text,
    url text,
    licence text,
    topic text,
    content text,
    embedding_model text,
    similarity double precision
)
    language sql
    stable
    security definer
    set search_path = ''
as $$
    select m.id, m.source_key, m.title, m.section, m.url, m.licence, m.topic, m.content,
           m.embedding_model, 1 - m.distance as similarity
    from (
        select c.*, c.embedding operator(extensions.<=>) query_embedding as distance
        from public.rag_chunks c
    ) m
    where query_embedding is not null and min_similarity is not null
        and 1 - m.distance >= min_similarity
    order by m.distance, m.id
    limit least(greatest(coalesce(match_count, 0), 0), 20);
$$;

revoke all on function public.match_rag_chunks(extensions.vector, integer, double precision)
    from public, anon, authenticated;
grant execute on function public.match_rag_chunks(extensions.vector, integer, double precision)
    to service_role;
