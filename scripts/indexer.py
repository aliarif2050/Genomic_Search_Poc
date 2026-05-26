from __future__ import annotations

import argparse
import gzip
import os
import sqlite3
import sys
from urllib.parse import unquote

# This script generates a highly compact, browser-friendly SQLite database containing
# a single FTS5 virtual table. It is specifically optimized for serverless, direct
# range-request functional search in the browser (bypassing normal coordinate tables/indexes).

BATCH_SIZE = 50_000

# Noisy feature types that are skipped in functional searches unless they have unique descriptions
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

# GFF column 9 attributes to extract and merge into the searchable annotations index
FUNCTIONAL_TAGS = [
    "Dbxref",
    "dbxref",
    "Ontology_term",
    "ontology_term",
    "GO",
    "gene_synonym",
    "Alias",
    "alias",
    "locus_tag",
    "standard_name",
    "function",
    "pfam",
    "Pfam",
    "PFAM",
    "interpro",
    "InterPro",
    "KEGG",
    "kegg",
    "eggNOG",
    "EC_number",
    "ec_number",
    "eC_number",
    "protein_id",
    "transcript_id",
    "inference",
    "experiment",
]

# GFF attribute keys mapped to specific search columns
DESCRIPTION_KEYS = ["description", "product", "Note", "note"]
NAME_KEYS = ["Name", "gene", "gene_name", "locus_tag", "standard_name"]
ID_KEYS = ["ID", "locus_tag", "protein_id", "transcript_id", "gene", "Name"]
BIOTYPE_KEYS = ["gene_biotype", "biotype", "transcript_biotype", "gbkey"]


def make_schema(use_prefix: bool = False) -> str:
    """
    Generate FTS5 schema. detail=none and columnsize=0 are enabled to dramatically
    minimize file size at the cost of phrase queries and native snippets.
    """
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
    feature_id,
    name,
    feature_type,
    seqid,
    start,
    end,
    strand,
    biotype,
    description,
    annotations
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
"""


def open_gff_text(path: str):
    """Open standard GFF or gzipped GFF files in read-text mode."""
    lower = path.lower()
    if lower.endswith(".gz") or lower.endswith(".bgz"):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def parse_attributes(attr_text: str) -> dict[str, list[str]]:
    """
    Parse GFF3 column 9 key-value attributes.
    Supports both key=value (GFF3) and GTF-style space-separated strings.
    """
    attrs: dict[str, list[str]] = {}
    if not attr_text or attr_text == ".":
        return attrs

    for part in attr_text.strip().split(";"):
        part = part.strip()
        if not part:
            continue

        if "=" in part:
            key, value = part.split("=", 1)
            key = key.strip()
            values = [unquote(v.strip()) for v in value.split(",") if v.strip()]
            if values:
                attrs.setdefault(key, []).extend(values)
        elif " " in part:
            key, value = part.split(" ", 1)
            key = key.strip()
            value = value.strip().strip('"')
            if key and value:
                attrs.setdefault(key, []).append(unquote(value))

    return attrs


def first_attr(attrs: dict[str, list[str]], keys: list[str], default: str = "") -> str:
    """Return the first available attribute value from a list of priority keys."""
    for key in keys:
        vals = attrs.get(key)
        if vals:
            return vals[0]
    return default


def compact_join(values: list[str], max_items: int = 6, max_chars: int = 500) -> str:
    """Deduplicate and join attribute values under a strict character limit."""
    clean = []
    for value in values:
        value = str(value).strip()
        if not value:
            continue
        if value not in clean:
            clean.append(value)
        if len(clean) >= max_items:
            break

    text = ", ".join(clean)
    if len(text) > max_chars:
        text = text[:max_chars].rstrip() + "..."
    return text


def build_annotations(
    attrs: dict[str, list[str]],
    already_used_values: set[str],
) -> str | None:
    """Consolidate high-value GFF functional annotations into a compact searchable field."""
    parts = []
    seen = set()

    for tag in FUNCTIONAL_TAGS:
        vals = attrs.get(tag)
        if not vals:
            continue

        filtered = []
        for value in vals:
            value = str(value).strip()
            if not value:
                continue

            value_key = value.lower()
            if value_key in already_used_values:
                continue

            dedupe_key = (tag.lower(), value_key)
            if dedupe_key in seen:
                continue

            seen.add(dedupe_key)
            filtered.append(value)

        if filtered:
            joined = compact_join(filtered)
            if joined:
                parts.append(f"{tag}: {joined}")

    return " | ".join(parts) if parts else None


def parse_gff_line(line: str, generated_id: int):
    """
    Convert a single raw GFF line into a compact database insertion tuple.
    Returns None if the line is low-value or lacks unique functional data.
    """
    line = line.strip()
    if not line or line.startswith("#"):
        return None

    cols = line.split("\t")
    if len(cols) < 9:
        return None

    seqid = cols[0].strip()
    feature_type = cols[2].strip()

    try:
        start = int(cols[3])
        end = int(cols[4])
    except ValueError:
        return None

    strand = cols[6].strip() if cols[6].strip() else "."
    attrs = parse_attributes(cols[8])

    feature_id = first_attr(attrs, ID_KEYS, default=f"generated_{generated_id}")
    name = first_attr(attrs, NAME_KEYS, default="")
    biotype = first_attr(attrs, BIOTYPE_KEYS, default="")
    description = first_attr(attrs, DESCRIPTION_KEYS, default="")

    if len(description) > 500:
        description = description[:500].rstrip() + "..."

    already_used_values = {
        v.lower()
        for v in [feature_id, name, biotype, description]
        if v
    }

    annotations = build_annotations(attrs, already_used_values)

    # Discard noisy/structural elements unless they hold functional descriptions
    ft_lower = feature_type.lower()
    has_real_annotation = bool(description or annotations or biotype)
    has_identity = bool(name or (feature_id and not feature_id.startswith("generated_")))

    if ft_lower in LOW_VALUE_TYPES and not has_real_annotation:
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
    """Initialize SQLite database and optimize PRAGMAs for fast bulk loading."""
    db_dir = os.path.dirname(os.path.abspath(db_path))
    os.makedirs(db_dir, exist_ok=True)

    if os.path.exists(db_path):
        os.remove(db_path)

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    cur.execute("PRAGMA journal_mode = OFF;")
    cur.execute("PRAGMA synchronous = OFF;")
    cur.execute("PRAGMA temp_store = MEMORY;")
    cur.execute("PRAGMA locking_mode = EXCLUSIVE;")
    cur.execute("PRAGMA secure_delete = OFF;")
    cur.execute(f"PRAGMA page_size = {int(page_size)};")
    cur.execute("PRAGMA cache_size = -200000;")

    cur.executescript(make_schema(use_prefix=use_prefix))
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
    """Stream GFF annotations into a compact FTS5 SQLite search index."""
    if isinstance(gff_paths, str):
        gff_paths = [gff_paths]

    print(f"[indexer] Creating compact FTS-only database: {db_path}")

    conn = prepare_database(
        db_path=db_path,
        page_size=page_size,
        use_prefix=use_prefix,
    )
    cur = conn.cursor()

    parsed_features = 0
    indexed_rows = 0
    skipped_rows = 0
    generated_id = 1

    batch: list[tuple] = []
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

                    generated_id += 1
                    parsed_features += 1
                    indexed_rows += 1
                    batch.append(row)

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


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a compact browser-friendly SQLite FTS5 index from GFF/GFF3/GFF.GZ files."
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
        help="Output SQLite database path. Default: ../public/genomics.db.zip",
    )

    parser.add_argument(
        "--page-size",
        type=int,
        default=4096,
        help="SQLite page size. 4096 is browser/range-request friendly. Default: 4096.",
    )

    parser.add_argument(
        "--prefix",
        action="store_true",
        help="Enable FTS prefix index for faster autocomplete, but DB will be larger.",
    )

    parser.add_argument(
        "--no-vacuum",
        action="store_true",
        help="Skip VACUUM at the end. Faster build, slightly larger DB.",
    )

    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional limit for testing only.",
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
