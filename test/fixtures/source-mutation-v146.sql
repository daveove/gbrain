-- Historical migration146 before retrieval and incident-source repairs.
      CREATE TABLE IF NOT EXISTS source_mutation_generation (
        source_id  TEXT PRIMARY KEY,
        generation BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_mutation_pending (
        id         BIGSERIAL PRIMARY KEY,
        source_id  TEXT NOT NULL
      );

      CREATE OR REPLACE FUNCTION note_source_mutation_pages_fn() RETURNS trigger
      SET search_path = pg_catalog, public AS $srcmut$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO source_mutation_pending (source_id)
          SELECT DISTINCT n.source_id FROM new_pages n WHERE n.source_id IS NOT NULL;
        ELSIF TG_OP = 'DELETE' THEN
          INSERT INTO source_mutation_pending (source_id)
          SELECT DISTINCT o.source_id FROM old_pages o WHERE o.source_id IS NOT NULL;
        ELSE
          INSERT INTO source_mutation_pending (source_id)
          SELECT DISTINCT s.source_id FROM (
            SELECT source_id FROM new_pages
            UNION
            SELECT source_id FROM old_pages
          ) s WHERE s.source_id IS NOT NULL;
        END IF;
        RETURN NULL;
      END;
      $srcmut$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION note_source_mutation_chunks_fn() RETURNS trigger
      SET search_path = pg_catalog, public AS $srcmut$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO source_mutation_pending (source_id)
          SELECT DISTINCT p.source_id
            FROM new_chunks c
            JOIN pages p ON p.id = c.page_id;
        ELSIF TG_OP = 'DELETE' THEN
          INSERT INTO source_mutation_pending (source_id)
          SELECT DISTINCT p.source_id
            FROM old_chunks c
            JOIN pages p ON p.id = c.page_id;
        ELSE
          INSERT INTO source_mutation_pending (source_id)
          SELECT DISTINCT p.source_id FROM (
            SELECT page_id FROM new_chunks
            UNION
            SELECT page_id FROM old_chunks
          ) c JOIN pages p ON p.id = c.page_id;
        END IF;
        RETURN NULL;
      END;
      $srcmut$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION note_source_mutation_links_fn() RETURNS trigger
      SET search_path = pg_catalog, public AS $srcmut$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO source_mutation_pending (source_id)
          SELECT DISTINCT p.source_id FROM (
            SELECT from_page_id AS page_id FROM new_links
            UNION
            SELECT to_page_id FROM new_links
          ) e JOIN pages p ON p.id = e.page_id;
        ELSIF TG_OP = 'DELETE' THEN
          INSERT INTO source_mutation_pending (source_id)
          SELECT DISTINCT p.source_id FROM (
            SELECT from_page_id AS page_id FROM old_links
            UNION
            SELECT to_page_id FROM old_links
          ) e JOIN pages p ON p.id = e.page_id;
        ELSE
          INSERT INTO source_mutation_pending (source_id)
          SELECT DISTINCT p.source_id FROM (
            SELECT from_page_id AS page_id FROM new_links
            UNION
            SELECT to_page_id FROM new_links
            UNION
            SELECT from_page_id FROM old_links
            UNION
            SELECT to_page_id FROM old_links
          ) e JOIN pages p ON p.id = e.page_id;
        END IF;
        RETURN NULL;
      END;
      $srcmut$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION note_source_mutation_sources_fn() RETURNS trigger
      SET search_path = pg_catalog, public AS $srcmut$
      BEGIN
        INSERT INTO source_mutation_pending (source_id)
        SELECT DISTINCT n.id
          FROM new_sources n
          JOIN old_sources o ON o.id = n.id
         WHERE n.archived IS DISTINCT FROM o.archived;
        RETURN NULL;
      END;
      $srcmut$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION apply_source_mutation_pending_fn() RETURNS trigger
      SET search_path = pg_catalog, public AS $srcmut$
      BEGIN
        INSERT INTO source_mutation_generation (source_id, generation)
        VALUES (NEW.source_id, 1)
        ON CONFLICT (source_id) DO UPDATE
          SET generation = source_mutation_generation.generation + 1;
        DELETE FROM source_mutation_pending WHERE id = NEW.id;
        RETURN NULL;
      END;
      $srcmut$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS source_mutation_pages_ins ON pages;
      CREATE TRIGGER source_mutation_pages_ins
        AFTER INSERT ON pages
        REFERENCING NEW TABLE AS new_pages
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_pages_fn();
      DROP TRIGGER IF EXISTS source_mutation_pages_upd ON pages;
      CREATE TRIGGER source_mutation_pages_upd
        AFTER UPDATE ON pages
        REFERENCING NEW TABLE AS new_pages OLD TABLE AS old_pages
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_pages_fn();
      DROP TRIGGER IF EXISTS source_mutation_pages_del ON pages;
      CREATE TRIGGER source_mutation_pages_del
        AFTER DELETE ON pages
        REFERENCING OLD TABLE AS old_pages
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_pages_fn();

      DROP TRIGGER IF EXISTS source_mutation_chunks_ins ON content_chunks;
      CREATE TRIGGER source_mutation_chunks_ins
        AFTER INSERT ON content_chunks
        REFERENCING NEW TABLE AS new_chunks
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_chunks_fn();
      DROP TRIGGER IF EXISTS source_mutation_chunks_upd ON content_chunks;
      CREATE TRIGGER source_mutation_chunks_upd
        AFTER UPDATE ON content_chunks
        REFERENCING NEW TABLE AS new_chunks OLD TABLE AS old_chunks
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_chunks_fn();
      DROP TRIGGER IF EXISTS source_mutation_chunks_del ON content_chunks;
      CREATE TRIGGER source_mutation_chunks_del
        AFTER DELETE ON content_chunks
        REFERENCING OLD TABLE AS old_chunks
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_chunks_fn();

      DROP TRIGGER IF EXISTS source_mutation_links_ins ON links;
      CREATE TRIGGER source_mutation_links_ins
        AFTER INSERT ON links
        REFERENCING NEW TABLE AS new_links
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_links_fn();
      DROP TRIGGER IF EXISTS source_mutation_links_upd ON links;
      CREATE TRIGGER source_mutation_links_upd
        AFTER UPDATE ON links
        REFERENCING NEW TABLE AS new_links OLD TABLE AS old_links
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_links_fn();
      DROP TRIGGER IF EXISTS source_mutation_links_del ON links;
      CREATE TRIGGER source_mutation_links_del
        AFTER DELETE ON links
        REFERENCING OLD TABLE AS old_links
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_links_fn();

      DROP TRIGGER IF EXISTS source_mutation_sources_upd ON sources;
      CREATE TRIGGER source_mutation_sources_upd
        AFTER UPDATE ON sources
        REFERENCING NEW TABLE AS new_sources OLD TABLE AS old_sources
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_sources_fn();

      DROP TRIGGER IF EXISTS apply_source_mutation_pending_trg ON source_mutation_pending;
      CREATE CONSTRAINT TRIGGER apply_source_mutation_pending_trg
        AFTER INSERT ON source_mutation_pending
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION apply_source_mutation_pending_fn();
