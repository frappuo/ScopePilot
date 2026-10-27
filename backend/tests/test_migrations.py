"""Static checks on the Supabase migrations. They are applied by hand in the dashboard, so no
test runs them; these checks keep their privilege and timeout rules from regressing."""

from pathlib import Path
import re

from app.services import logbook

MIGRATIONS = Path(__file__).resolve().parents[2] / "supabase" / "migrations"


def read(name):
    return (MIGRATIONS / name).read_text(encoding="utf-8")


def functions(sql):
    """{name: full "create function ... $$;" text} for public functions."""
    return {m.group(1): m.group(0) for m in re.finditer(r"create function public\.(\w+)\(.*?\$\$;", sql, re.S)}


def test_0002_functions_are_definer_with_empty_search_path_and_backend_only():
    sql = read("0002_logbook_caps.sql")
    found = functions(sql)
    assert set(found) == {"create_draft", "discard_draft", "update_experiment"}
    for name, text in found.items():
        header = text.split("as $$")[0]
        assert "security definer" in header
        assert "set search_path = ''" in header
        expected = "6s" if name == "discard_draft" else "3s"
        assert f"set lock_timeout = '{expected}'" in header
        assert re.search(rf"revoke all on function public\.{name}\([^)]*\)\s+from public, anon, authenticated;", sql)
        grants = re.findall(rf"grant execute on function public\.{name}\([^)]*\)\s+to ([^;]+);", sql)
        assert grants == ["service_role"]


def test_0002_functions_take_the_same_per_user_lock():
    found = functions(read("0002_logbook_caps.sql"))
    locks = {re.search(r"pg_advisory_xact_lock\((.*)\);", text).group(1) for text in found.values()}
    assert locks == {"hashtextextended('scopepilot.experiments:' || p_user::text, 0)"}


def test_0002_argument_checks():
    sql = read("0002_logbook_caps.sql")
    create_draft = functions(sql)["create_draft"]
    # Exact image layout, which DELETE's path-based cleanup relies on.
    assert "p_image_path is distinct from p_user::text || '/' || p_id::text || '/image.jpg'" in create_draft
    assert "p_thumb_path is distinct from p_user::text || '/' || p_id::text || '/thumb.jpg'" in create_draft
    # The deadline is checked after the lock is taken and before any write.
    lock, deadline, insert = (create_draft.index(marker) for marker in (
        "pg_advisory_xact_lock", "clock_timestamp() > p_deadline", "insert into public.experiments"))
    assert lock < deadline < insert
    # A missing cap counts as reached.
    assert "p_max_drafts is null or live >= p_max_drafts" in create_draft
    assert "p_max_saved is null or saved_count >= p_max_saved" in functions(sql)["update_experiment"]
    # discard_draft only ever deletes drafts.
    assert "status = 'draft'" in functions(sql)["discard_draft"]


def test_0002_documents_the_isolation_assumption():
    assert "READ COMMITTED" in read("0002_logbook_caps.sql")


def test_0002_statement_timeout_is_below_the_client_timeout():
    sql = read("0002_logbook_caps.sql")
    match = re.search(r"alter role service_role set statement_timeout = '(\d+)s';", sql)
    assert match and int(match.group(1)) < logbook.SUPABASE_TIMEOUT_SECONDS
    assert "notify pgrst, 'reload config';" in sql


def test_0002_discard_outwaits_a_running_create():
    # A create still running when discard_draft waits must finish or hit statement_timeout
    # before the discard's lock_timeout, and the discard must answer before the client gives up.
    sql = read("0002_logbook_caps.sql")
    statement = int(re.search(r"statement_timeout = '(\d+)s'", sql).group(1))
    discard = int(re.search(r"set lock_timeout = '(\d+)s'", functions(sql)["discard_draft"]).group(1))
    assert statement < discard < logbook.SUPABASE_TIMEOUT_SECONDS


def test_0003_table_is_backend_only():
    sql = read("0003_rag.sql")
    assert "create extension if not exists vector with schema extensions;" in sql
    assert "alter table public.rag_chunks enable row level security;" in sql
    assert "create policy" not in sql
    assert "revoke all on public.rag_chunks from anon, authenticated, service_role;" in sql
    grants = re.findall(r"^grant (.+?) on public\.rag_chunks to (.+?);$", sql, re.M)
    assert grants == [("select, insert, delete", "service_role")]


def test_0003_match_function_is_definer_with_empty_search_path_and_backend_only():
    sql = read("0003_rag.sql")
    found = functions(sql)
    assert set(found) == {"match_rag_chunks"}
    header = found["match_rag_chunks"].split("as $$")[0]
    for clause in ("language sql", "stable", "security definer", "set search_path = ''"):
        assert clause in header
    assert re.search(r"revoke all on function public\.match_rag_chunks\([^)]*\)\s+from public, anon, authenticated;", sql)
    grants = re.findall(r"grant execute on function public\.match_rag_chunks\([^)]*\)\s+to ([^;]+);", sql)
    assert grants == ["service_role"]


def test_0003_cosine_match_with_threshold_and_clamped_count():
    sql = read("0003_rag.sql")
    # The table column and the query argument; the embedding service uses the same size.
    assert re.findall(r"vector\((\d+)\)", sql) == ["768", "768"]
    body = functions(sql)["match_rag_chunks"]
    assert "operator(extensions.<=>)" in body
    assert "1 - m.distance >= min_similarity" in body
    assert "order by m.distance, m.id" in body
    assert "limit least(greatest(coalesce(match_count, 0), 0), 20);" in body
    # A missing argument returns nothing.
    assert "query_embedding is not null and min_similarity is not null" in body
    # Exact scan at this size: no approximate index.
    assert not re.search(r"using\s+(hnsw|ivfflat)", sql, re.I)


def test_0003_column_checks():
    sql = read("0003_rag.sql")
    assert "content_hash text not null unique check (content_hash ~ '^[0-9a-f]{64}$')" in sql
    assert "url text not null check (url ~ '^https://'" in sql
    assert "user_id" not in sql
    licence = re.compile(re.search(r"check \(licence ~ '([^']+)'\)", sql).group(1))
    for accepted in ("CC BY 4.0", "CC BY-SA 4.0", "CC BY 3.0", "CC BY-SA 2.5", "CC BY 2.0"):
        assert licence.search(accepted), accepted
    for refused in ("CC BY-NC 4.0", "CC BY-NC-SA 4.0", "CC BY-ND 4.0", "CC0 1.0", "CC BY 1.0",
                    "CC BY 4.0 ", "cc by 4.0", "CC BY-SA 4.0 International"):
        assert not licence.search(refused), refused
