#!/usr/bin/env python3

#   indexer.py — GFF3 → SQLite+FTS5 Indexer
#   ========================================
#   Parses a GFF3 file using gffutils and produces a genomics.db SQLite database
#   with:
#    • `features`   --> main table holding genomic coordinates + metadata
#    • `features_fts` --> FTS5 virtual table for full-text search on Name / ID / description


import argparse
import os
import sqlite3
import sys
import tempfile

import gffutils
from gffutils.exceptions import EmptyInputError


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

SCHEMA_MAIN = """
CREATE TABLE IF NOT EXISTS features (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id  TEXT NOT NULL,          -- GFF ID attribute
    name        TEXT,                   -- GFF Name attribute
    feature_type TEXT NOT NULL,         -- gene, mRNA, exon, CDS …
    seqid       TEXT NOT NULL,          -- chromosome / scaffold
    start       INTEGER NOT NULL,
    end         INTEGER NOT NULL,
    strand      TEXT,
    biotype     TEXT,
    description TEXT
);
"""

SCHEMA_FTS = """
CREATE VIRTUAL TABLE IF NOT EXISTS features_fts USING fts5(
    feature_id,
    name,
    feature_type,
    description,
    content='features',
    content_rowid='id'
);
"""

# Triggers keep the FTS index in sync when rows change.
TRIGGERS = """
CREATE TRIGGER IF NOT EXISTS features_ai AFTER INSERT ON features BEGIN
    INSERT INTO features_fts(rowid, feature_id, name, feature_type, description)
    VALUES (new.id, new.feature_id, new.name, new.feature_type, new.description);
END;

CREATE TRIGGER IF NOT EXISTS features_ad AFTER DELETE ON features BEGIN
    INSERT INTO features_fts(features_fts, rowid, feature_id, name, feature_type, description)
    VALUES ('delete', old.id, old.feature_id, old.name, old.feature_type, old.description);
END;

CREATE TRIGGER IF NOT EXISTS features_au AFTER UPDATE ON features BEGIN
    INSERT INTO features_fts(features_fts, rowid, feature_id, name, feature_type, description)
    VALUES ('delete', old.id, old.feature_id, old.name, old.feature_type, old.description);
    INSERT INTO features_fts(rowid, feature_id, name, feature_type, description)
    VALUES (new.id, new.feature_id, new.name, new.feature_type, new.description);
END;
"""

INSERT_FEATURE = """
INSERT INTO features (feature_id, name, feature_type, seqid, start, end, strand, biotype, description)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
"""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _attr(feature, key: str, default: str = "") -> str:
    """Safely retrieve a single-valued GFF attribute."""
    vals = feature.attributes.get(key, [default])
    return vals[0] if vals else default


def build_database(gff_path: str, db_path: str) -> None:
    """Parse *gff_path* and write an indexed SQLite database to *db_path*."""

    # --- 1. Create gffutils DB in a temp file --------------------------------
    print(f"[indexer] Parsing GFF3: {gff_path}")
    tmp_gffdb = tempfile.mkstemp(suffix=".gffutils.db")
    try:
        gff_db = gffutils.create_db(
            gff_path,
            dbfn=tmp_gffdb,
            force=True,
            keep_order=True,
            merge_strategy="merge",
            sort_attribute_values=True,
        )
    except EmptyInputError:
        # Empty GFF file -> produce an empty but schema-correct database
        print("[indexer] WARNING: GFF file contains no features.")
        if os.path.exists(db_path):
            os.remove(db_path)
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.executescript(SCHEMA_MAIN)
        cur.executescript(SCHEMA_FTS)
        cur.executescript(TRIGGERS)
        conn.commit()
        conn.close()
        try:
            if os.path.exists(tmp_gffdb):
                os.remove(tmp_gffdb)
        except OSError:
            pass
        print(f"[indexer] Wrote 0 features -> {db_path}")
        return
    except Exception as exc:
        print(f"[indexer] ERROR creating gffutils db: {exc}", file=sys.stderr)
        raise

    # --- 2. Create output SQLite database ------------------------------------
    if os.path.exists(db_path):
        os.remove(db_path)

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.executescript(SCHEMA_MAIN)
    cur.executescript(SCHEMA_FTS)
    cur.executescript(TRIGGERS)
    conn.commit()

    # --- 3. Iterate features and insert rows ---------------------------------
    count = 0
    for feature in gff_db.all_features():
        feature_id  = _attr(feature, "ID")
        name        = _attr(feature, "Name")
        biotype     = _attr(feature, "biotype")
        description = _attr(feature, "description")
        strand      = feature.strand if feature.strand else "."

        cur.execute(INSERT_FEATURE, (
            feature_id,
            name,
            feature.featuretype,
            feature.seqid,
            int(feature.start),
            int(feature.end),
            strand,
            biotype,
            description,
        ))
        count += 1

    conn.commit()

    # --- 4. Optimise FTS index -----------------------------------------------
    cur.execute("INSERT INTO features_fts(features_fts) VALUES ('optimize');")
    conn.commit()
    conn.close()

    # Close the gffutils database before removing the temp file
    del gff_db

    # Clean up temp gffutils db
    try:
        if os.path.exists(tmp_gffdb):
            os.remove(tmp_gffdb)
    except OSError:
        pass  # Best-effort cleanup on Windows

    print(f"[indexer] Wrote {count} features -> {db_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Index a GFF3 file into a SQLite+FTS5 database."
    )
    parser.add_argument(
        "gff",
        help="Path to the input GFF3 file.",
    )
    parser.add_argument(
        "-o", "--output",
        default=os.path.join(os.path.dirname(__file__), "..", "public", "genomics.db"),
        help="Path to the output SQLite database (default: ../public/genomics.db).",
    )
    args = parser.parse_args()

    build_database(args.gff, args.output)


if __name__ == "__main__":
    main()
