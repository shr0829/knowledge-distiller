# Product
<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
Implementation default for the user's approved plan: Python with uv, FastAPI,
SQLite, React, Fluent UI, a local MCP server and Codex plugin. The user did not
specify framework versions.

## Users
The user works in Codex and maintains an Obsidian knowledge library on Windows.

## Product Purpose
Capture relevant conversations, propose knowledge changes, learn from human
review, and gradually automate approved categories while retaining provenance
and undo.

## Operating Context
Local-first. A separate test vault must be used until the user connects their
real vault. Background model calls require explicit configuration and consent.

## Capabilities and Constraints
Review save, update, discard, edit, and defer operations. Learn from genuine
human decisions. Evaluate policies independently before promotion. No automatic
deletion, permission expansion, or self-modification of code.

## Evidence on Hand
The preceding research and architecture are approved implementation scope.
All demonstration data must be labeled synthetic. On 2026-10-14 the user chose
an independent real Obsidian vault. E:\files\知序知识库 is connected to the
E:\project\libary project. The Codex sidebar uses MCP Apps. No background model
credentials were supplied.

## Product Principles
- Human feedback and execution authorization are separate.
- Content is portable Markdown; operational state is local SQLite.
- Every write has source evidence, an expected version, and recovery records.
- Automation is per project, category, and operation.
