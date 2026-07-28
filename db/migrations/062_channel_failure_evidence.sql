-- ============================================================
--  062 · D112 — failures must carry their own evidence
--  (renumbered from 060 — PR #123 owns 060_template_content_kinds and
--   061_communication_triggers; independent of both, safe in any order)
--
--  2026-07-28: reconstructing what Beds24 actually said took hours, because
--  the failure path mapped the response to a category string and DISCARDED the
--  original — "(422)" was printed for a response that was HTTP 201, and the
--  word that mattered ("invalid dates") sat in a body we never persisted.
--
--  From now on the error record itself carries the raw evidence, captured at
--  the moment of failure and BEFORE any parsing or categorisation:
--    · http_status            — the actual HTTP status received, verbatim.
--                               NULL means no response was received at all
--                               (timeout / network / payload never sent).
--    · response_body          — the raw response body text, unmodified,
--                               truncated to 2048 chars. The stored prefix is
--                               verbatim; response_truncated is the explicit
--                               truncation marker.
--    · response_truncated     — true when response_body was cut at 2KB.
--    · request_payload        — the request body that produced the failure.
--    · response_received_at   — UTC timestamp taken when the response (or the
--                               transport failure) was observed.
--
--  The mapped category (error_code) is DERIVED data and stays alongside — it
--  never replaces the original. Existing rows keep NULLs: evidence cannot be
--  reconstructed retroactively, and pretending otherwise would be fabrication.
--
--  Idempotent. Safe to replay.
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.channel_sync_errors
  ADD COLUMN IF NOT EXISTS http_status          int,
  ADD COLUMN IF NOT EXISTS response_body        text,
  ADD COLUMN IF NOT EXISTS response_truncated   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS request_payload      jsonb,
  ADD COLUMN IF NOT EXISTS response_received_at timestamptz;
