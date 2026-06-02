from __future__ import annotations

import argparse
import gzip
import os
import sqlite3
import sys
import time
from urllib.parse import unquote


BATCH_SIZE = 150_000

# Case-robust set of noisy feature types skipped in functional searches unless they carry annotations
LOW_VALUE_TYPES = {
    "exon",
    "region",
    "chromosome",
    "supercontig",
    "contig",
    "match",
    "match_part",
    "cdna_match",
    "est_match",
    "sequence_feature",
}

FUNCTIONAL_TAGS = [
    "dbxref", "ontology_term", "go", "gene_synonym", "alias", "locus_tag", 
    "standard_name", "function", "pfam", "interpro", "kegg", "eggnog", 
    "ec_number", "protein_id", "transcript_id", "inference", "experiment"
]

DESCRIPTION_KEYS = ["description", "product", "note"]
NAME_KEYS = ["name", "gene", "gene_name", "locus_tag", "standard_name"]
ID_KEYS = ["id", "locus_tag", "protein_id", "transcript_id", "gene", "name"]
BIOTYPE_KEYS = ["gene_biotype", "biotype", "transcript_biotype", "gbkey"]


def make_schema(use_prefix: bool = False) -> str:
    prefix_sql = ",\n    prefix='3 4'" if use_prefix else ""

    return f"""
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    feature_id,
    name,
    feature_type UNINDEXED,
    seqid UNINDEXED,
    start UNINDEXED,
    end UNINDEXED,
    strand UNINDEXED,
    biotype,
    description,
    annotations,
    tokenize='unicode61',
    detail=none,
    columnsize=0{prefix_sql}
);
"""


INSERT_INDEX = """
INSERT INTO search_index (
    feature_id, name, feature_type, seqid, start, end,
    strand, biotype, description, annotations
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
"""


def open_gff_text(path: str):
    # Handles both normal and gzipped GFFs
    if path.lower().endswith((".gz", ".bgz")):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")

    return open(path, "r", encoding="utf-8", errors="replace")


def parse_attributes(attr_text: str) -> dict[str, list[str]]:
    attrs: dict[str, list[str]] = {}

    if not attr_text or attr_text == ".":
        return attrs

    for part in attr_text.strip().split(";"):
        part = part.strip()

        if not part:
            continue

        if "=" in part:
            key, value = part.split("=", 1)
            values = [unquote(v.strip()) for v in value.split(",") if v.strip()]

            if values:
                attrs.setdefault(key.strip().lower(), []).extend(values)

        elif " " in part:
            key, value = part.split(" ", 1)
            value = value.strip().strip('"')

            if key.strip() and value:
                attrs.setdefault(key.strip().lower(), []).append(unquote(value))

    return attrs


def first_attr(attrs: dict[str, list[str]], keys: list[str], default: str = "") -> str:
    # Grabs the first available value based on a list of priority keys
    for key in keys:
        values = attrs.get(key)

        if values:
            return values[0]

    return default


def compact_join(values: list[str], max_items: int = 6, max_chars: int = 500) -> str:
    """Join pre-deduplicated values under a strict character limit."""
    text = ", ".join(values[:max_items])
    if len(text) > max_chars:
        return text[:max_chars].rstrip() + "..."
    return text


def build_annotations(
    attrs: dict[str, list[str]],
    feature_id: str,
    name: str,
    biotype: str,
    description: str,
) -> str | None:
    """Consolidate high-value GFF functional annotations into a compact searchable field."""
    parts = []
    seen = set()
    already_used_values = None  # Lazily evaluated to save CPU on structural lines

    for tag in FUNCTIONAL_TAGS:
        values = attrs.get(tag)

        if not values:
            continue

        if already_used_values is None:
            already_used_values = {
                v.lower()
                for v in (feature_id, name, biotype, description)
                if v
            }

        filtered = []
        tag_lower = tag.lower()

        for value in values:
            value_key = value.lower()
            dedupe_key = (tag_lower, value_key)

            if value_key in already_used_values or dedupe_key in seen:
                continue

            seen.add(dedupe_key)
            filtered.append(value)

        if filtered:
            joined = compact_join(filtered)
            if joined:
                parts.append(f"{tag}: {joined}")

    return " | ".join(parts) if parts else None


def parse_gff_line(line: str, generated_id: int):
    # Fast path: check for comments or whitespace before running expensive string operations
    if not line or line[0] == "#" or line.isspace():
        return None

    # Strip only standard newline trailing terminators
    line = line.rstrip("\r\n")
    cols = line.split("\t")

    if len(cols) < 9:
        return None

    try:
        start = int(cols[3])
        end = int(cols[4])
    except ValueError:
        return None

    # Columns are guaranteed to be space-free, so direct access is faster than calling .strip()
    seqid = cols[0]
    feature_type = cols[2]
    feature_type_key = feature_type.lower()
    strand = cols[6] if cols[6] != "." and cols[6] != "" else "."
    attrs = parse_attributes(cols[8])

    feature_id = first_attr(attrs, ID_KEYS, default=f"generated_{generated_id}")
    name = first_attr(attrs, NAME_KEYS)
    biotype = first_attr(attrs, BIOTYPE_KEYS)
    description = first_attr(attrs, DESCRIPTION_KEYS)

    if len(description) > 500:
        description = description[:500].rstrip() + "..."

    annotations = build_annotations(attrs, feature_id, name, biotype, description)

    has_real_annotation = bool(description or annotations or biotype)
    has_identity = bool(name or not feature_id.startswith("generated_"))

    # Direct O(1) set lookup bypassing runtime feature_type.lower() string allocations
    if feature_type_key in LOW_VALUE_TYPES and not has_real_annotation:
        return None

    if not has_real_annotation and not has_identity:
        return None

    return (
        feature_id,
        name,
        feature_type,
        seqid,
        start,
        end,
        strand,
        biotype,
        description,
        annotations,
    )


def prepare_database(
    db_path: str,
    page_size: int,
    use_prefix: bool,
) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)

    if os.path.exists(db_path):
        os.remove(db_path)

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Fast bulk-build settings
    cur.execute("PRAGMA journal_mode = OFF;")
    cur.execute("PRAGMA synchronous = OFF;")
    cur.execute("PRAGMA temp_store = MEMORY;")
    cur.execute("PRAGMA locking_mode = EXCLUSIVE;")
    cur.execute("PRAGMA secure_delete = OFF;")
    cur.execute(f"PRAGMA page_size = {int(page_size)};")
    cur.execute("PRAGMA cache_size = -300000;")

    cur.executescript(make_schema(use_prefix))
    conn.commit()

    return conn


def insert_batch(cur: sqlite3.Cursor, batch: list[tuple]) -> None:
    if batch:
        cur.executemany(INSERT_INDEX, batch)


def build_database(
    gff_paths: str | list[str],
    db_path: str,
    page_size: int = 4096,
    use_prefix: bool = False,
    vacuum: bool = True,
    limit: int | None = None,
) -> None:
    start_time = time.time()
    if isinstance(gff_paths, str):
        gff_paths = [gff_paths]

    print(f"[indexer] Creating compact FTS-only database: {db_path}")

    conn = prepare_database(db_path, page_size, use_prefix)
    cur = conn.cursor()

    parsed_features = 0
    indexed_rows = 0
    skipped_rows = 0
    generated_id = 1
    batch = []

    cur.execute("BEGIN;")

    try:
        for gff_path in gff_paths:
            print(f"[indexer] Reading: {gff_path}")

            if not os.path.exists(gff_path):
                raise FileNotFoundError(f"Input file not found: {gff_path}")

            with open_gff_text(gff_path) as handle:
                for line in handle:
                    if limit is not None and parsed_features >= limit:
                        break

                    row = parse_gff_line(line, generated_id)

                    if row is None:
                        skipped_rows += 1
                        continue

                    batch.append(row)
                    generated_id += 1
                    parsed_features += 1
                    indexed_rows += 1

                    if len(batch) >= BATCH_SIZE:
                        insert_batch(cur, batch)
                        batch.clear()

                        if indexed_rows % 100_000 == 0:
                            print(f"[indexer] Indexed {indexed_rows:,} compact rows...")

            if limit is not None and parsed_features >= limit:
                break

        insert_batch(cur, batch)
        conn.commit()

    except Exception:
        conn.rollback()
        conn.close()
        raise

    print("[indexer] Optimizing FTS...")
    cur.execute("INSERT INTO search_index(search_index) VALUES ('optimize');")
    conn.commit()

    print("[indexer] Running ANALYZE...")
    cur.execute("ANALYZE;")
    conn.commit()

    if vacuum:
        print("[indexer] Vacuuming database...")
        cur.execute("VACUUM;")
        conn.commit()

    conn.close()

    size_mb = os.path.getsize(db_path) / (1024 * 1024)

    print("[indexer] Done.")
    print(f"[indexer] Indexed searchable rows: {indexed_rows:,}")
    print(f"[indexer] Skipped low-value/invalid rows: {skipped_rows:,}")
    print(f"[indexer] Output: {db_path}")
    print(f"[indexer] DB size: {size_mb:.2f} MB")
    print(f"[indexer] Time elapsed: {time.time() - start_time:.2f} seconds")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a compact browser-friendly SQLite FTS5 index from GFF files."
    )

    parser.add_argument(
        "gff",
        nargs="+",
        help="One or more input files: .gff, .gff3, .gff.gz, .gff3.gz",
    )

    parser.add_argument(
        "-o",
        "--output",
        default=os.path.join(
            os.path.dirname(__file__),
            "..",
            "public",
            "genomics.db.zip",
        ),
        help="Output DB path. Default: ../public/genomics.db.zip",
    )

    parser.add_argument(
        "--page-size",
        type=int,
        default=4096,
        help="SQLite page size. Default: 4096.",
    )

    parser.add_argument(
        "--prefix",
        action="store_true",
        help="Enable prefix search. Increases DB size.",
    )

    parser.add_argument(
        "--no-vacuum",
        action="store_true",
        help="Skip final VACUUM.",
    )

    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit rows for testing.",
    )

    args = parser.parse_args()

    try:
        build_database(
            gff_paths=args.gff,
            db_path=args.output,
            page_size=args.page_size,
            use_prefix=args.prefix,
            vacuum=not args.no_vacuum,
            limit=args.limit,
        )
    except Exception as exc:
        print(f"[indexer] ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()