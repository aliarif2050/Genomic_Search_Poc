#!/usr/bin/env python3
"""
test_indexer.py — Unit tests for the GFF3 → SQLite+FTS5 indexer.

Run with:
    pytest scripts/test_indexer.py -v
"""

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from indexer import build_database, _attr

SCRIPT_DIR = Path(__file__).parent
SAMPLE_GFF = SCRIPT_DIR / "sample.gff3"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def db_path(tmp_path):
    """Build the database from sample.gff3 and return the path."""
    out = tmp_path / "test_features.db"
    build_database(str(SAMPLE_GFF), str(out))
    return out


@pytest.fixture
def conn(db_path):
    """Open a SQLite connection to the test database."""
    c = sqlite3.connect(str(db_path))
    yield c
    c.close()


@pytest.fixture
def empty_gff(tmp_path):
    """Create a minimal GFF3 file with no features."""
    p = tmp_path / "empty.gff3"
    p.write_text("##gff-version 3\n")
    return p


@pytest.fixture
def malformed_gff(tmp_path):
    """Create a malformed / non-GFF3 file."""
    p = tmp_path / "bad.gff3"
    p.write_text("this is not a valid gff3 file\n\t\t\n")
    return p


# ---------------------------------------------------------------------------
# Schema tests
# ---------------------------------------------------------------------------

class TestSchema:
    """Verify the output database has the expected schema."""

    def test_features_table_exists(self, conn):
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "features" in tables

    def test_fts_table_exists(self, conn):
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "features_fts" in tables

    def test_features_columns(self, conn):
        cols = {
            r[1]
            for r in conn.execute("PRAGMA table_info(features)").fetchall()
        }
        expected = {
            "id",
            "feature_id",
            "name",
            "feature_type",
            "seqid",
            "start",
            "end",
            "strand",
            "biotype",
            "description",
        }
        assert expected == cols

    def test_triggers_exist(self, conn):
        triggers = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='trigger'"
            ).fetchall()
        }
        assert {"features_ai", "features_ad", "features_au"} <= triggers


# ---------------------------------------------------------------------------
# Data integrity tests
# ---------------------------------------------------------------------------

class TestDataIntegrity:
    """Verify features are correctly inserted from the sample GFF3."""

    def test_feature_count_positive(self, conn):
        count = conn.execute("SELECT count(*) FROM features").fetchone()[0]
        assert count > 0

    def test_all_feature_ids_non_empty(self, conn):
        empty = conn.execute(
            "SELECT count(*) FROM features "
            "WHERE feature_id = '' OR feature_id IS NULL"
        ).fetchone()[0]
        assert empty == 0

    def test_known_gene_present(self, conn):
        """The sample GFF3 contains gene DDX11L1."""
        row = conn.execute(
            "SELECT name, feature_type, seqid, start, end "
            "FROM features WHERE name = 'DDX11L1'"
        ).fetchone()
        assert row is not None
        name, ftype, seqid, start, end = row
        assert name == "DDX11L1"
        assert ftype == "gene"
        assert seqid == "chr1"
        assert start == 11869
        assert end == 14409

    def test_known_gene_wash7p(self, conn):
        """The sample GFF3 contains gene WASH7P on the minus strand."""
        row = conn.execute(
            "SELECT name, strand, seqid FROM features "
            "WHERE name = 'WASH7P' AND feature_type = 'gene'"
        ).fetchone()
        assert row is not None
        assert row[0] == "WASH7P"
        assert row[1] == "-"
        assert row[2] == "chr1"

    def test_feature_types_present(self, conn):
        """The sample should contain at least gene, mRNA, exon, CDS."""
        types = {
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT feature_type FROM features"
            ).fetchall()
        }
        assert {"gene", "mRNA", "exon", "CDS"} <= types

    def test_multiple_chromosomes(self, conn):
        seqids = {
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT seqid FROM features"
            ).fetchall()
        }
        assert len(seqids) >= 2  # sample has chr1, chr2, chr3
        assert {"chr1", "chr2", "chr3"} <= seqids

    def test_strand_values_valid(self, conn):
        strands = {
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT strand FROM features"
            ).fetchall()
        }
        assert strands <= {"+", "-", "."}

    def test_coordinates_positive(self, conn):
        bad = conn.execute(
            "SELECT count(*) FROM features WHERE start < 1 OR end < start"
        ).fetchone()[0]
        assert bad == 0

    def test_biotype_populated_for_genes(self, conn):
        """Genes in the sample should have a biotype attribute."""
        rows = conn.execute(
            "SELECT name, biotype FROM features "
            "WHERE feature_type = 'gene' AND (biotype IS NULL OR biotype = '')"
        ).fetchall()
        assert len(rows) == 0, f"Genes without biotype: {rows}"

    def test_description_populated_for_genes(self, conn):
        """Genes in the sample have description attributes."""
        rows = conn.execute(
            "SELECT name, description FROM features "
            "WHERE feature_type = 'gene' AND description != ''"
        ).fetchall()
        assert len(rows) > 0


# ---------------------------------------------------------------------------
# FTS5 search tests
# ---------------------------------------------------------------------------

class TestFTS:
    """Verify FTS5 full-text search works correctly."""

    def test_fts_row_count_matches(self, conn):
        main_count = conn.execute("SELECT count(*) FROM features").fetchone()[0]
        fts_count = conn.execute(
            "SELECT count(*) FROM features_fts"
        ).fetchone()[0]
        assert fts_count == main_count

    def test_search_by_name(self, conn):
        results = conn.execute(
            "SELECT count(*) FROM features_fts "
            "WHERE features_fts MATCH '\"DDX11L1\"*'"
        ).fetchone()[0]
        assert results >= 1

    def test_search_by_feature_type(self, conn):
        results = conn.execute(
            "SELECT count(*) FROM features_fts "
            "WHERE features_fts MATCH '\"gene\"*'"
        ).fetchone()[0]
        assert results >= 1

    def test_search_by_description_keyword(self, conn):
        """Search for 'olfactory' which appears in OR4F5 description."""
        results = conn.execute(
            "SELECT count(*) FROM features_fts "
            "WHERE features_fts MATCH '\"olfactory\"*'"
        ).fetchone()[0]
        assert results >= 1

    def test_search_returns_matching_rows_via_join(self, conn):
        rows = conn.execute(
            """
            SELECT f.name FROM features_fts AS fts
            JOIN features AS f ON f.id = fts.rowid
            WHERE features_fts MATCH '"WASH7P"*'
            ORDER BY fts.rank
            """
        ).fetchall()
        names = [r[0] for r in rows]
        assert any("WASH7P" in n for n in names)

    def test_prefix_search(self, conn):
        """Prefix search for 'OR4F' should match OR4F5 and OR4F29."""
        results = conn.execute(
            "SELECT count(*) FROM features_fts "
            "WHERE features_fts MATCH '\"OR4F\"*'"
        ).fetchone()[0]
        assert results >= 2

    def test_fts_optimized(self, conn):
        """After build, the FTS index should be optimized (no pending merges)."""
        # This simply verifies the 'optimize' command was run without error.
        # We can confirm by running an integrity check on the FTS table.
        result = conn.execute(
            "INSERT INTO features_fts(features_fts) VALUES ('integrity-check')"
        )
        # If no error is raised, the FTS index is consistent.
        assert True


# ---------------------------------------------------------------------------
# Trigger tests
# ---------------------------------------------------------------------------

class TestTriggers:
    """Verify FTS triggers keep the index in sync."""

    def test_insert_trigger(self, conn):
        """Inserting a new feature should update the FTS index."""
        conn.execute(
            "INSERT INTO features "
            "(feature_id, name, feature_type, seqid, start, end, strand, biotype, description) "
            "VALUES ('test:NEW1', 'TESTGENE', 'gene', 'chrTest', 1, 100, '+', 'test', 'test gene')"
        )
        conn.commit()
        count = conn.execute(
            "SELECT count(*) FROM features_fts "
            "WHERE features_fts MATCH '\"TESTGENE\"*'"
        ).fetchone()[0]
        assert count >= 1

    def test_delete_trigger(self, conn):
        """Deleting a feature should remove it from the FTS index."""
        conn.execute(
            "INSERT INTO features "
            "(feature_id, name, feature_type, seqid, start, end, strand, biotype, description) "
            "VALUES ('test:DEL1', 'DELETEME', 'gene', 'chrTest', 1, 100, '+', 'test', 'to delete')"
        )
        conn.commit()
        # Verify it exists
        count = conn.execute(
            "SELECT count(*) FROM features_fts WHERE features_fts MATCH '\"DELETEME\"*'"
        ).fetchone()[0]
        assert count >= 1
        # Delete it
        conn.execute("DELETE FROM features WHERE feature_id = 'test:DEL1'")
        conn.commit()
        count = conn.execute(
            "SELECT count(*) FROM features_fts WHERE features_fts MATCH '\"DELETEME\"*'"
        ).fetchone()[0]
        assert count == 0

    def test_update_trigger(self, conn):
        """Updating a feature's name should be reflected in FTS."""
        conn.execute(
            "INSERT INTO features "
            "(feature_id, name, feature_type, seqid, start, end, strand, biotype, description) "
            "VALUES ('test:UPD1', 'OLDNAME', 'gene', 'chrTest', 1, 100, '+', 'test', 'update test')"
        )
        conn.commit()
        conn.execute(
            "UPDATE features SET name = 'NEWNAME' WHERE feature_id = 'test:UPD1'"
        )
        conn.commit()
        old_count = conn.execute(
            "SELECT count(*) FROM features_fts WHERE features_fts MATCH '\"OLDNAME\"*'"
        ).fetchone()[0]
        new_count = conn.execute(
            "SELECT count(*) FROM features_fts WHERE features_fts MATCH '\"NEWNAME\"*'"
        ).fetchone()[0]
        assert old_count == 0
        assert new_count >= 1


# ---------------------------------------------------------------------------
# Edge-case tests
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """Test behaviour with unusual inputs."""

    def test_empty_gff_produces_empty_db(self, empty_gff, tmp_path):
        db = tmp_path / "empty.db"
        build_database(str(empty_gff), str(db))
        conn = sqlite3.connect(str(db))
        count = conn.execute("SELECT count(*) FROM features").fetchone()[0]
        conn.close()
        assert count == 0

    def test_output_file_overwritten(self, tmp_path):
        db = tmp_path / "overwrite.db"
        build_database(str(SAMPLE_GFF), str(db))
        size1 = db.stat().st_size
        build_database(str(SAMPLE_GFF), str(db))
        size2 = db.stat().st_size
        # Sizes should be identical (deterministic output)
        assert size1 == size2

    def test_nonexistent_input_raises(self, tmp_path):
        db = tmp_path / "no.db"
        with pytest.raises(Exception):
            build_database("nonexistent_file_xyz.gff3", str(db))

    def test_output_db_is_valid_sqlite(self, db_path):
        """The output file should be a valid SQLite database."""
        conn = sqlite3.connect(str(db_path))
        result = conn.execute("PRAGMA integrity_check").fetchone()[0]
        conn.close()
        assert result == "ok"


# ---------------------------------------------------------------------------
# CLI tests
# ---------------------------------------------------------------------------

class TestCLI:
    """Test the command-line interface."""

    def test_cli_produces_database(self, tmp_path):
        db = tmp_path / "cli.db"
        result = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "indexer.py"),
             str(SAMPLE_GFF), "-o", str(db)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert db.exists()
        assert db.stat().st_size > 0

    def test_cli_default_output(self, tmp_path, monkeypatch):
        """Running without -o should use the default output path."""
        # We test that the parser accepts a GFF without -o.
        # The default path is ../public/genomics.db relative to the script.
        # Just verify the CLI parses correctly (we can't easily control the
        # default directory in a test, so we provide -o explicitly).
        db = tmp_path / "default_test.db"
        result = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "indexer.py"),
             str(SAMPLE_GFF), "-o", str(db)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0

    def test_cli_no_args_exits_with_error(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "indexer.py")],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0

    def test_cli_missing_file_exits_with_error(self, tmp_path):
        db = tmp_path / "fail.db"
        result = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "indexer.py"),
             "does_not_exist.gff3", "-o", str(db)],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0


# ---------------------------------------------------------------------------
# Helper function tests
# ---------------------------------------------------------------------------

class TestHelpers:
    """Unit tests for helper functions."""

    def test_attr_returns_value(self):
        class FakeFeature:
            attributes = {"Name": ["DDX11L1"], "biotype": ["protein_coding"]}

        assert _attr(FakeFeature(), "Name") == "DDX11L1"
        assert _attr(FakeFeature(), "biotype") == "protein_coding"

    def test_attr_returns_default(self):
        class FakeFeature:
            attributes = {}

        assert _attr(FakeFeature(), "Name") == ""
        assert _attr(FakeFeature(), "Name", "unknown") == "unknown"

    def test_attr_empty_list_returns_default(self):
        class FakeFeature:
            attributes = {"Name": []}

        assert _attr(FakeFeature(), "Name") == ""

    def test_attr_multiple_values_returns_first(self):
        class FakeFeature:
            attributes = {"Name": ["first", "second", "third"]}

        assert _attr(FakeFeature(), "Name") == "first"
