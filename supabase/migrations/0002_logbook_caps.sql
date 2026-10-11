-- ScopePilot student logbook, PR 4: database-enforced draft and saved caps, timeouts.
-- Apply once in the Supabase dashboard SQL editor, after 0001_logbook.sql.
--
-- Assumes PostgREST's default READ COMMITTED isolation: each count below runs after the
-- per-user advisory lock is taken, so it sees every row committed by an earlier holder.

-- Backend requests reach Postgres as service_role through PostgREST. A statement timeout
-- shorter than the backend's 10 s client timeout (SUPABASE_TIMEOUT_SECONDS) makes a slow
-- statement abort instead of committing after the backend has given up and cleaned up.
-- A timeout set inside a function does not apply to the running statement, so it is set
-- on the role. PostgREST applies role settings once its config is reloaded.
alter role service_role set statement_timeout = '5s';
notify pgrst, 'reload config';

-- Creates a draft unless the user already has p_max_drafts live drafts.
-- Returns {"result": "ok", "row": {...}}, or, having written nothing, {"result": ...} with
-- "draft_limit", "late" (called after p_deadline) or "invalid_arguments". Backend only.
create function public.create_draft(
    p_user uuid,
    p_id uuid,
    p_max_drafts integer,
    p_ttl_hours integer,
    p_deadline timestamptz,
    p_analysis jsonb,
    p_model text,
    p_prompt_version text,
    p_image_path text,
    p_thumb_path text,
    p_image_bytes integer
) returns jsonb
    language plpgsql
    security definer
    set search_path = ''
    set lock_timeout = '3s'
as $$
declare
    live integer;
    created public.experiments;
begin
    -- Images live at <user>/<id>/image.jpg and thumb.jpg; deletes rebuild exactly these paths.
    if p_user is null or p_id is null or p_ttl_hours is null or p_ttl_hours <= 0
            or p_image_path is distinct from p_user::text || '/' || p_id::text || '/image.jpg'
            or p_thumb_path is distinct from p_user::text || '/' || p_id::text || '/thumb.jpg' then
        return jsonb_build_object('result', 'invalid_arguments');
    end if;
    -- One create, save or discard per user at a time, so counts and writes cannot interleave.
    perform pg_advisory_xact_lock(hashtextextended('scopepilot.experiments:' || p_user::text, 0));
    -- Past the deadline the backend has given up and cleans up with discard_draft, so a call
    -- that only gets here now must not write a row that nothing will clean up.
    if p_deadline is null or clock_timestamp() > p_deadline then
        return jsonb_build_object('result', 'late');
    end if;
    select count(*) into live
        from public.experiments
        where user_id = p_user and status = 'draft' and expires_at > now();
    -- A missing or non-positive cap counts as reached.
    if p_max_drafts is null or live >= p_max_drafts then
        return jsonb_build_object('result', 'draft_limit');
    end if;
    insert into public.experiments (id, user_id, status, analysis, model, prompt_version,
                                    image_path, thumb_path, image_bytes, expires_at)
    values (p_id, p_user, 'draft', p_analysis, p_model, p_prompt_version,
            p_image_path, p_thumb_path, p_image_bytes, now() + make_interval(hours => p_ttl_hours))
    returning * into created;
    return jsonb_build_object('result', 'ok', 'row', to_jsonb(created));
end;
$$;

-- Deletes the user's draft p_id if it exists. It takes the same per-user lock as create_draft,
-- so a create_draft call that is already running finishes first and its row is then removed.
-- Used by the backend after a failed create. Returns true if a row was deleted.
create function public.discard_draft(p_user uuid, p_id uuid) returns boolean
    language plpgsql
    security definer
    set search_path = ''
    -- Longer than statement_timeout (5 s), so a running create always finishes or rolls back
    -- before this gives up; still under the backend's 10 s client timeout.
    set lock_timeout = '6s'
as $$
declare
    removed integer;
begin
    if p_user is null or p_id is null then
        return false;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('scopepilot.experiments:' || p_user::text, 0));
    delete from public.experiments
        where id = p_id and user_id = p_user and status = 'draft';
    get diagnostics removed = row_count;
    return removed > 0;
end;
$$;

-- Edits title/notes and optionally saves a draft (status 'saved', saved_at now(),
-- expires_at null, in one UPDATE as 0001 requires). A null p_title or p_notes leaves the
-- value unchanged. Expired drafts count as missing.
-- Returns {"result": "ok", "row": {...}}, or "not_found", "title_required", "saved_limit",
-- "invalid_arguments".
create function public.update_experiment(
    p_user uuid,
    p_id uuid,
    p_title text,
    p_notes text,
    p_save boolean,
    p_max_saved integer
) returns jsonb
    language plpgsql
    security definer
    set search_path = ''
    set lock_timeout = '3s'
as $$
declare
    existing public.experiments;
    saved_count integer;
    updated public.experiments;
begin
    if p_user is null or p_id is null or p_save is null then
        return jsonb_build_object('result', 'invalid_arguments');
    end if;
    perform pg_advisory_xact_lock(hashtextextended('scopepilot.experiments:' || p_user::text, 0));
    select * into existing
        from public.experiments
        where id = p_id and user_id = p_user and (status = 'saved' or expires_at > now())
        for update;
    if not found then
        return jsonb_build_object('result', 'not_found');
    end if;
    if p_save and existing.status = 'draft' then
        if coalesce(p_title, existing.title) is null then
            return jsonb_build_object('result', 'title_required');
        end if;
        select count(*) into saved_count
            from public.experiments
            where user_id = p_user and status = 'saved';
        -- A missing or non-positive cap counts as reached.
        if p_max_saved is null or saved_count >= p_max_saved then
            return jsonb_build_object('result', 'saved_limit');
        end if;
    end if;
    update public.experiments set
        title = coalesce(p_title, title),
        notes = coalesce(p_notes, notes),
        status = case when p_save then 'saved' else status end,
        saved_at = case when p_save and status = 'draft' then now() else saved_at end,
        expires_at = case when p_save then null else expires_at end
    where id = p_id and user_id = p_user
    returning * into updated;
    return jsonb_build_object('result', 'ok', 'row', to_jsonb(updated));
end;
$$;

revoke all on function public.create_draft(uuid, uuid, integer, integer, timestamptz, jsonb, text, text, text, text, integer)
    from public, anon, authenticated;
grant execute on function public.create_draft(uuid, uuid, integer, integer, timestamptz, jsonb, text, text, text, text, integer)
    to service_role;
revoke all on function public.discard_draft(uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.discard_draft(uuid, uuid)
    to service_role;
revoke all on function public.update_experiment(uuid, uuid, text, text, boolean, integer)
    from public, anon, authenticated;
grant execute on function public.update_experiment(uuid, uuid, text, text, boolean, integer)
    to service_role;
