from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Kind = Literal["knowledge", "decision", "experience", "preference", "task", "hypothesis"]
Action = Literal["save", "update", "discard", "defer"]


def clean_text(value: str) -> str:
    if not value.strip() or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
        raise ValueError("Text must be nonempty and contain no control characters")
    return value


class Candidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=24000)
    kind: Kind = "knowledge"
    source: str = Field(min_length=1, max_length=24000)
    tags: list[str] = Field(default_factory=list, max_length=12)
    links: list[str] = Field(default_factory=list, max_length=12)
    target: str | None = Field(default=None, max_length=500)
    uncertain: bool = False

    @field_validator("title")
    @classmethod
    def title_is_single_line(cls, value: str) -> str:
        clean_text(value)
        if "\n" in value or "\r" in value:
            raise ValueError("Title must be a single line")
        return value.strip()

    @field_validator("content", "source")
    @classmethod
    def content_is_text(cls, value: str) -> str:
        return clean_text(value)

    @field_validator("tags")
    @classmethod
    def valid_tags(cls, value: list[str]) -> list[str]:
        if any(not re.fullmatch(r"[^\W\d][\w/-]{0,79}", tag, re.UNICODE)
               or "//" in tag or tag.endswith("/") for tag in value):
            raise ValueError("Tags must start with a letter and contain only letters, digits, _, - or /")
        return list(dict.fromkeys(value))

    @field_validator("links")
    @classmethod
    def valid_links(cls, value: list[str]) -> list[str]:
        if any(not link.strip() or len(link) > 500 or any(c in link for c in "[]|#\r\n") for link in value):
            raise ValueError("Invalid wiki link")
        return list(dict.fromkeys(value))


class Submission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str
    session_id: str = Field(min_length=1, max_length=200)
    candidates: list[Candidate] = Field(min_length=1, max_length=20)

    @field_validator("session_id")
    @classmethod
    def valid_session(cls, value: str) -> str:
        return clean_text(value)


class Review(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)
    action: Action
    reason: str = Field(default="", max_length=2000)
    title: str | None = Field(default=None, min_length=1, max_length=160)
    content: str | None = Field(default=None, min_length=1, max_length=24000)
    target: str | None = Field(default=None, min_length=1, max_length=500)
    links: list[str] | None = Field(default=None, max_length=12)
    tags: list[str] | None = Field(default=None, max_length=12)
    preview_token: str | None = Field(default=None, max_length=200)


class ProjectInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    root: str
    vault: str
    writable_dirs: list[str] = Field(default_factory=lambda: ["Library"], min_length=1, max_length=50)
    excluded_dirs: list[str] = Field(default_factory=lambda: [".obsidian", ".git"], max_length=50)
    source_excluded_dirs: list[str] = Field(default_factory=list, max_length=50)
    capture_enabled: bool = True
    synthetic: bool = False
    min_samples: int = Field(default=50, ge=20, le=10000)
    min_sessions: int = Field(default=5, ge=3, le=1000)
    max_error: float = Field(default=0.05, ge=0.001, le=0.2)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        return clean_text(value).strip()


class ModelSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    provider: Literal['openai_compatible', 'codex_cli'] = 'openai_compatible'
    endpoint: str = "http://localhost:11434/v1"
    model: str = ""
    key_env: str = "LIBRARY_MODEL_API_KEY"
    daily_calls: int = Field(default=30, ge=0, le=1000)
    max_input_chars: int = Field(default=16000, ge=1000, le=100000)
    max_tokens: int = Field(default=2000, ge=100, le=8000)
    learning_enabled: bool = False

