import pytest

from backend.app.auth import ensure_secret_key_is_safe


def test_ensure_secret_key_rejects_weak_defaults_for_non_local_postgres(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.delenv("ALLOW_INSECURE_SECRET_KEY", raising=False)
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/boodchappen")
    monkeypatch.setenv("SECRET_KEY", "change-me")

    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        ensure_secret_key_is_safe()


def test_ensure_secret_key_allows_local_sqlite_dev_secret(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.delenv("ALLOW_INSECURE_SECRET_KEY", raising=False)
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.setenv("DATABASE_URL", "sqlite:///./app.db")
    monkeypatch.setenv("SECRET_KEY", "dev-secret")

    assert ensure_secret_key_is_safe() == "dev-secret"