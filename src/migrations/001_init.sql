-- 001_init: core Engram schema (see V2 Build Spec § Data model)

CREATE TABLE items (
  id              TEXT PRIMARY KEY,        -- nanoid
  type            TEXT NOT NULL,           -- 'fact' | 'explanation' | 'project'
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'retired'
  parent_item_id  TEXT REFERENCES items(id),       -- set for split children
  source_point_id TEXT,                    -- rubric point that spawned this child
  note_path       TEXT,                    -- vault-relative path (null for auto-spawned children)
  title           TEXT NOT NULL,
  prompt          TEXT NOT NULL,           -- the question / explanation prompt incl. audience
  answer          TEXT,                    -- fact items only
  trap            TEXT,                    -- explanation/project items
  followup        TEXT,                    -- explanation/project items
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- FSRS state (managed exclusively by ts-fsrs)
  due             TIMESTAMPTZ NOT NULL,
  stability       DOUBLE PRECISION,
  difficulty      DOUBLE PRECISION,
  reps            INTEGER NOT NULL DEFAULT 0,
  lapses          INTEGER NOT NULL DEFAULT 0,
  fsrs_state      INTEGER NOT NULL DEFAULT 0,  -- New/Learning/Review/Relearning
  last_review     TIMESTAMPTZ
);

CREATE TABLE rubric_points (
  id        TEXT PRIMARY KEY,
  item_id   TEXT NOT NULL REFERENCES items(id),
  ord       INTEGER NOT NULL,
  text      TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'active'   -- 'active' | 'split' | 'retired'
);

CREATE TABLE reviews (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES items(id),
  reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  rating       INTEGER NOT NULL              -- FSRS rating actually applied (1-4)
);

CREATE TABLE point_scores (
  review_id  TEXT NOT NULL REFERENCES reviews(id),
  point_id   TEXT NOT NULL REFERENCES rubric_points(id),
  score      TEXT NOT NULL,                  -- 'hit' | 'partial' | 'miss'
  PRIMARY KEY (review_id, point_id)
);

CREATE INDEX idx_items_due ON items (due) WHERE status = 'active';
CREATE INDEX idx_points_item ON rubric_points (item_id);
