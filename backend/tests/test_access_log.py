"""uvicorn's access log bypasses the app's own logging, so it must not carry experiment IDs or
query strings (list cursors). The first test runs a real uvicorn server on a free local port."""

import logging
import threading
import time
import uuid

import httpx
import pytest
import uvicorn

from app.config import Settings, get_settings
from app.main import AccessLogFilter, _configure_logging, app

ACCESS_FORMAT = '%s - "%s %s HTTP/%s" %d'  # uvicorn's own access-log call (protocols/http).


def dummy_settings():
    return Settings(_env_file=None, gemini_api_key="test-key-not-real",
                    supabase_url="https://example-project.supabase.co",
                    supabase_secret_key="dummy-supabase-secret-for-tests")


@pytest.mark.parametrize("http", ["h11", "httptools"])
def test_uvicorn_access_log_templates_ids_and_drops_query(caplog, http):
    if http == "httptools":
        pytest.importorskip("httptools")  # Only installed with uvicorn[standard].
    app.dependency_overrides[get_settings] = dummy_settings
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, access_log=True,
                                           log_config=None, lifespan="off", http=http))
    thread = threading.Thread(target=server.run, daemon=True)
    experiment_id = str(uuid.uuid4())
    try:
        with caplog.at_level(logging.INFO, logger="uvicorn.access"):
            thread.start()
            started_by = time.monotonic() + 10
            while not server.started:
                assert thread.is_alive() and time.monotonic() < started_by, "uvicorn did not start"
                time.sleep(0.05)
            port = server.servers[0].sockets[0].getsockname()[1]
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False) as client:
                # No bearer token: 401 from the middleware, so no Supabase or Gemini call is made.
                response = client.get(f"/v1/experiments/{experiment_id}", params={"cursor": "secret-cursor"})
                assert response.status_code == 401
                ask = client.post(f"/v1/experiments/{experiment_id}/ask", json={"question": "Why?"})
                assert ask.status_code == 401
                assert client.get("/health").status_code == 200
            server.should_exit = True
            thread.join(10)
    finally:
        server.should_exit = True
        app.dependency_overrides.clear()
    assert not thread.is_alive()
    lines = [record.getMessage() for record in caplog.records if record.name == "uvicorn.access"]
    assert any('"GET /v1/experiments/{id} HTTP/1.1" 401' in line for line in lines), lines
    assert any('"POST /v1/experiments/{id}/ask HTTP/1.1" 401' in line for line in lines), lines
    assert any('"GET /health HTTP/1.1" 200' in line for line in lines), lines
    assert experiment_id not in caplog.text
    assert "secret-cursor" not in caplog.text and "cursor=" not in caplog.text


def access_record(*args):
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, ACCESS_FORMAT, args, None)


def test_filter_templates_paths_and_drops_queries():
    experiment_id = str(uuid.uuid4())
    record = access_record("10.0.0.1:5000", "DELETE", f"/v1/experiments/{experiment_id}?cursor=x", "1.1", 204)
    assert AccessLogFilter().filter(record)
    assert record.getMessage() == '10.0.0.1:5000 - "DELETE /v1/experiments/{id} HTTP/1.1" 204'
    unknown_path = access_record("10.0.0.1:5000", "GET", "/somewhere/private?token=x", "1.1", 404)
    assert AccessLogFilter().filter(unknown_path)
    assert unknown_path.getMessage() == '10.0.0.1:5000 - "GET other HTTP/1.1" 404'


@pytest.mark.parametrize("suffix,template", [
    ("/ask?x=1", "/v1/experiments/{id}/ask"),
    ("/quiz", "/v1/experiments/{id}/quiz"),
    ("/other", "/v1/experiments/{id}"),
    ("/ask/extra", "/v1/experiments/{id}"),
    ("", "/v1/experiments/{id}"),
])
def test_filter_templates_experiment_actions(suffix, template):
    experiment_id = str(uuid.uuid4())
    record = access_record("10.0.0.1:5000", "POST", f"/v1/experiments/{experiment_id}{suffix}", "1.1", 200)
    assert AccessLogFilter().filter(record)
    assert record.getMessage() == f'10.0.0.1:5000 - "POST {template} HTTP/1.1" 200'
    assert experiment_id not in record.getMessage()


def test_filter_empty_id_segment_is_not_an_action():
    record = access_record("10.0.0.1:5000", "POST", "/v1/experiments//ask", "1.1", 404)
    assert AccessLogFilter().filter(record)
    assert record.getMessage() == '10.0.0.1:5000 - "POST /v1/experiments/{id} HTTP/1.1" 404'


def test_filter_drops_records_in_an_unknown_format():
    experiment_id = str(uuid.uuid4())
    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, "request %s",
                               (f"/v1/experiments/{experiment_id}",), None)
    assert not AccessLogFilter().filter(record)


def test_filter_installed_once():
    _configure_logging()
    _configure_logging()
    filters = logging.getLogger("uvicorn.access").filters
    assert sum(isinstance(f, AccessLogFilter) for f in filters) == 1
