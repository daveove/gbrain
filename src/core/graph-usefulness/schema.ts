/** Idempotent modern graph installation; only pre-existing legacy tables expire once. */
export const GRAPH_RETRIEVAL_CONFIG_KEYS = ["embedding_columns", "embedding_multimodal_model", "search.adaptive_return", "search.adaptive_return_entity_max", "search.adaptive_return_min_keep", "search.adaptive_return_other_max", "search.autocut", "search.autocut_jump", "search.autocut_min_keep", "search.autocut_min_top", "search.cache.enabled", "search.cache.similarity_threshold", "search.cache.ttl_seconds", "search.contextual_retrieval", "search.contextual_retrieval_disabled", "search.cross_modal.both_mode_image_weight", "search.cross_modal.both_mode_text_weight", "search.cross_modal.llm_intent", "search.evidence_cosine_floor", "search.expansion", "search.expansion_variant_budget", "search.floor_ratio", "search.graph_signals", "search.image_query.image_refinement_weight", "search.image_query.text_refinement_weight", "search.intentWeighting", "search.intent_patterns", "search.keywordOrFallback", "search.keyword_arm_confidence_floor", "search.metadata_boost_gate", "search.mode", "search.relational_rerank_pin", "search.relational_retrieval", "search.relational_retrieval_depth", "search.reranker.enabled", "search.reranker.model", "search.reranker.timeout_ms", "search.reranker.top_n_in", "search.reranker.top_n_out", "search.searchLimit", "search.title_boost", "search.tokenBudget", "search.unified_multimodal", "search.unified_multimodal_only", "search_embedding_column"] as const;

export const GRAPH_SOURCE_MUTATION_SCHEMA_SQL = `
DO $modern_graph$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM config WHERE key='migration.source_mutation_generation.modern.170') THEN
    IF to_regclass('public.source_mutation_generation') IS NOT NULL THEN
      INSERT INTO source_mutation_generation (source_id,generation)
      SELECT id,1 FROM sources ORDER BY id COLLATE "C"
      ON CONFLICT(source_id) DO UPDATE SET generation=source_mutation_generation.generation+1;
    END IF;
    INSERT INTO config(key,value) VALUES('migration.source_mutation_generation.modern.170','installed') ON CONFLICT(key) DO NOTHING;
  END IF;
END $modern_graph$;


      CREATE TABLE IF NOT EXISTS source_mutation_generation (
        source_id  TEXT PRIMARY KEY,
        generation BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_mutation_pending (
        id         BIGSERIAL PRIMARY KEY,
        source_id  TEXT NOT NULL,
        transaction_id BIGINT NOT NULL DEFAULT txid_current(),
        is_global_config BOOLEAN NOT NULL DEFAULT false
      );

      ALTER TABLE source_mutation_pending ADD COLUMN IF NOT EXISTS transaction_id BIGINT NOT NULL DEFAULT txid_current();

      ALTER TABLE source_mutation_pending ADD COLUMN IF NOT EXISTS is_global_config BOOLEAN NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS graph_search_mutation_generation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation BIGINT NOT NULL DEFAULT 0
      );
      INSERT INTO graph_search_mutation_generation(singleton) VALUES(1) ON CONFLICT DO NOTHING;

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
          WITH changed AS (
            SELECT n.id, n.source_id, o.source_id AS prior_source_id,
                   (n.source_id IS DISTINCT FROM o.source_id
                    OR n.slug IS DISTINCT FROM o.slug
                    OR n.deleted_at IS DISTINCT FROM o.deleted_at) AS endpoint_changed
              FROM new_pages n JOIN old_pages o ON o.id = n.id
             WHERE n.source_id IS DISTINCT FROM o.source_id
                OR n.slug IS DISTINCT FROM o.slug
                OR n.deleted_at IS DISTINCT FROM o.deleted_at
                OR n.knowledge_revision IS DISTINCT FROM o.knowledge_revision
                OR n.effective_date IS DISTINCT FROM o.effective_date
                OR n.updated_at IS DISTINCT FROM o.updated_at
                OR n.created_at IS DISTINCT FROM o.created_at
                OR n.emotional_weight IS DISTINCT FROM o.emotional_weight
                OR n.generation IS DISTINCT FROM o.generation
                OR n.content_hash IS DISTINCT FROM o.content_hash
                OR n.compiled_truth IS DISTINCT FROM o.compiled_truth
                OR n.type IS DISTINCT FROM o.type
          )
          SELECT DISTINCT affected.source_id FROM (
            SELECT source_id FROM changed
            UNION ALL SELECT prior_source_id FROM changed
            UNION ALL
            SELECT p.source_id FROM changed c
              JOIN links l ON l.from_page_id = c.id OR l.to_page_id = c.id OR l.origin_page_id = c.id
              JOIN pages p ON p.id = l.from_page_id OR p.id = l.to_page_id
             WHERE c.endpoint_changed
          ) affected WHERE affected.source_id IS NOT NULL;
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
        IF TG_OP = 'INSERT' THEN
          INSERT INTO source_mutation_pending(source_id) SELECT id FROM new_sources;
        ELSIF TG_OP = 'DELETE' THEN
          INSERT INTO source_mutation_pending(source_id) SELECT id FROM old_sources;
        ELSE
        INSERT INTO source_mutation_pending (source_id)
        WITH changed AS (
          SELECT n.id FROM new_sources n JOIN old_sources o ON o.id = n.id
           WHERE n.archived IS DISTINCT FROM o.archived
             OR n.incarnation IS DISTINCT FROM o.incarnation
        )
        SELECT DISTINCT affected.source_id FROM (
          SELECT id AS source_id FROM changed
          UNION ALL
          SELECT neighbor.source_id FROM changed c
            JOIN pages endpoint ON endpoint.source_id = c.id
            JOIN links l ON l.from_page_id = endpoint.id OR l.to_page_id = endpoint.id OR l.origin_page_id = endpoint.id
            JOIN pages neighbor ON neighbor.id = l.from_page_id OR neighbor.id = l.to_page_id
        ) affected;
        END IF;
        RETURN NULL;
      END;
      $srcmut$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION apply_source_mutation_pending_fn() RETURNS trigger
      SET search_path = pg_catalog, public AS $srcmut$
      DECLARE
        affected_source TEXT;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM source_mutation_pending WHERE id = NEW.id) THEN
          RETURN NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM source_mutation_pending
                   WHERE transaction_id = NEW.transaction_id AND is_global_config) THEN
          UPDATE graph_search_mutation_generation SET generation = generation + 1 WHERE singleton = 1;
        END IF;
        FOR affected_source IN
          SELECT source_id FROM source_mutation_pending
           WHERE transaction_id = NEW.transaction_id AND NOT is_global_config
           GROUP BY source_id ORDER BY source_id COLLATE "C"
        LOOP
          INSERT INTO source_mutation_generation (source_id, generation)
          VALUES (affected_source, 1)
          ON CONFLICT (source_id) DO UPDATE
            SET generation = source_mutation_generation.generation + 1;
        END LOOP;
        DELETE FROM source_mutation_pending WHERE transaction_id = NEW.transaction_id;
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

      CREATE OR REPLACE FUNCTION note_source_mutation_page_aliases_fn() RETURNS trigger
      SET search_path = pg_catalog, public AS $srcmut$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO source_mutation_pending(source_id) SELECT source_id FROM new_rows;
        ELSIF TG_OP = 'DELETE' THEN
          INSERT INTO source_mutation_pending(source_id) SELECT source_id FROM old_rows;
        ELSE
          INSERT INTO source_mutation_pending(source_id) SELECT source_id FROM new_rows UNION SELECT source_id FROM old_rows;
        END IF;
        RETURN NULL;
      END;
      $srcmut$ LANGUAGE plpgsql;
      DO $graph_page_aliases$
      BEGIN
        IF to_regclass('public.page_aliases') IS NOT NULL THEN
      DROP TRIGGER IF EXISTS source_mutation_page_aliases_insert ON page_aliases;
      CREATE TRIGGER source_mutation_page_aliases_insert AFTER INSERT ON page_aliases
        REFERENCING NEW TABLE AS new_rows
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_page_aliases_fn();
      DROP TRIGGER IF EXISTS source_mutation_page_aliases_delete ON page_aliases;
      CREATE TRIGGER source_mutation_page_aliases_delete AFTER DELETE ON page_aliases
        REFERENCING OLD TABLE AS old_rows
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_page_aliases_fn();
      DROP TRIGGER IF EXISTS source_mutation_page_aliases_update ON page_aliases;
      CREATE TRIGGER source_mutation_page_aliases_update AFTER UPDATE ON page_aliases
        REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_page_aliases_fn();
        END IF;
      END $graph_page_aliases$;

      CREATE OR REPLACE FUNCTION note_source_mutation_slug_aliases_fn() RETURNS trigger
      SET search_path = pg_catalog, public AS $srcmut$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO source_mutation_pending(source_id) SELECT source_id FROM new_rows;
        ELSIF TG_OP = 'DELETE' THEN
          INSERT INTO source_mutation_pending(source_id) SELECT source_id FROM old_rows;
        ELSE
          INSERT INTO source_mutation_pending(source_id) SELECT source_id FROM new_rows UNION SELECT source_id FROM old_rows;
        END IF;
        RETURN NULL;
      END;
      $srcmut$ LANGUAGE plpgsql;
      DO $graph_slug_aliases$
      BEGIN
        IF to_regclass('public.slug_aliases') IS NOT NULL THEN
      DROP TRIGGER IF EXISTS source_mutation_slug_aliases_insert ON slug_aliases;
      CREATE TRIGGER source_mutation_slug_aliases_insert AFTER INSERT ON slug_aliases
        REFERENCING NEW TABLE AS new_rows
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_slug_aliases_fn();
      DROP TRIGGER IF EXISTS source_mutation_slug_aliases_delete ON slug_aliases;
      CREATE TRIGGER source_mutation_slug_aliases_delete AFTER DELETE ON slug_aliases
        REFERENCING OLD TABLE AS old_rows
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_slug_aliases_fn();
      DROP TRIGGER IF EXISTS source_mutation_slug_aliases_update ON slug_aliases;
      CREATE TRIGGER source_mutation_slug_aliases_update AFTER UPDATE ON slug_aliases
        REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_slug_aliases_fn();
        END IF;
      END $graph_slug_aliases$;

      CREATE OR REPLACE FUNCTION note_source_mutation_takes_fn() RETURNS trigger
      SET search_path = pg_catalog, public AS $srcmut$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO source_mutation_pending(source_id) SELECT p.source_id FROM new_rows r JOIN pages p ON p.id=r.page_id;
        ELSIF TG_OP = 'DELETE' THEN
          INSERT INTO source_mutation_pending(source_id) SELECT p.source_id FROM old_rows r JOIN pages p ON p.id=r.page_id;
        ELSE
          INSERT INTO source_mutation_pending(source_id) SELECT p.source_id FROM new_rows r JOIN pages p ON p.id=r.page_id UNION SELECT p.source_id FROM old_rows r JOIN pages p ON p.id=r.page_id;
        END IF;
        RETURN NULL;
      END;
      $srcmut$ LANGUAGE plpgsql;
      DO $graph_takes$
      BEGIN
        IF to_regclass('public.takes') IS NOT NULL THEN
      DROP TRIGGER IF EXISTS source_mutation_takes_insert ON takes;
      CREATE TRIGGER source_mutation_takes_insert AFTER INSERT ON takes
        REFERENCING NEW TABLE AS new_rows
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_takes_fn();
      DROP TRIGGER IF EXISTS source_mutation_takes_delete ON takes;
      CREATE TRIGGER source_mutation_takes_delete AFTER DELETE ON takes
        REFERENCING OLD TABLE AS old_rows
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_takes_fn();
      DROP TRIGGER IF EXISTS source_mutation_takes_update ON takes;
      CREATE TRIGGER source_mutation_takes_update AFTER UPDATE ON takes
        REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_takes_fn();

        END IF;
      END $graph_takes$;

      CREATE OR REPLACE FUNCTION note_graph_search_config_fn() RETURNS trigger
      SET search_path = pg_catalog, public AS $srcmut$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO source_mutation_pending(source_id,is_global_config)
          SELECT 'config',true FROM new_config WHERE key IN ('embedding_columns', 'embedding_multimodal_model', 'search.adaptive_return', 'search.adaptive_return_entity_max', 'search.adaptive_return_min_keep', 'search.adaptive_return_other_max', 'search.autocut', 'search.autocut_jump', 'search.autocut_min_keep', 'search.autocut_min_top', 'search.cache.enabled', 'search.cache.similarity_threshold', 'search.cache.ttl_seconds', 'search.contextual_retrieval', 'search.contextual_retrieval_disabled', 'search.cross_modal.both_mode_image_weight', 'search.cross_modal.both_mode_text_weight', 'search.cross_modal.llm_intent', 'search.evidence_cosine_floor', 'search.expansion', 'search.expansion_variant_budget', 'search.floor_ratio', 'search.graph_signals', 'search.image_query.image_refinement_weight', 'search.image_query.text_refinement_weight', 'search.intentWeighting', 'search.intent_patterns', 'search.keywordOrFallback', 'search.keyword_arm_confidence_floor', 'search.metadata_boost_gate', 'search.mode', 'search.relational_rerank_pin', 'search.relational_retrieval', 'search.relational_retrieval_depth', 'search.reranker.enabled', 'search.reranker.model', 'search.reranker.timeout_ms', 'search.reranker.top_n_in', 'search.reranker.top_n_out', 'search.searchLimit', 'search.title_boost', 'search.tokenBudget', 'search.unified_multimodal', 'search.unified_multimodal_only', 'search_embedding_column') LIMIT 1;
        ELSIF TG_OP = 'DELETE' THEN
          INSERT INTO source_mutation_pending(source_id,is_global_config)
          SELECT 'config',true FROM old_config WHERE key IN ('embedding_columns', 'embedding_multimodal_model', 'search.adaptive_return', 'search.adaptive_return_entity_max', 'search.adaptive_return_min_keep', 'search.adaptive_return_other_max', 'search.autocut', 'search.autocut_jump', 'search.autocut_min_keep', 'search.autocut_min_top', 'search.cache.enabled', 'search.cache.similarity_threshold', 'search.cache.ttl_seconds', 'search.contextual_retrieval', 'search.contextual_retrieval_disabled', 'search.cross_modal.both_mode_image_weight', 'search.cross_modal.both_mode_text_weight', 'search.cross_modal.llm_intent', 'search.evidence_cosine_floor', 'search.expansion', 'search.expansion_variant_budget', 'search.floor_ratio', 'search.graph_signals', 'search.image_query.image_refinement_weight', 'search.image_query.text_refinement_weight', 'search.intentWeighting', 'search.intent_patterns', 'search.keywordOrFallback', 'search.keyword_arm_confidence_floor', 'search.metadata_boost_gate', 'search.mode', 'search.relational_rerank_pin', 'search.relational_retrieval', 'search.relational_retrieval_depth', 'search.reranker.enabled', 'search.reranker.model', 'search.reranker.timeout_ms', 'search.reranker.top_n_in', 'search.reranker.top_n_out', 'search.searchLimit', 'search.title_boost', 'search.tokenBudget', 'search.unified_multimodal', 'search.unified_multimodal_only', 'search_embedding_column') LIMIT 1;
        ELSE
          INSERT INTO source_mutation_pending(source_id,is_global_config)
          SELECT 'config',true FROM new_config n FULL JOIN old_config o ON n.key=o.key
           WHERE COALESCE(n.key,o.key) IN ('embedding_columns', 'embedding_multimodal_model', 'search.adaptive_return', 'search.adaptive_return_entity_max', 'search.adaptive_return_min_keep', 'search.adaptive_return_other_max', 'search.autocut', 'search.autocut_jump', 'search.autocut_min_keep', 'search.autocut_min_top', 'search.cache.enabled', 'search.cache.similarity_threshold', 'search.cache.ttl_seconds', 'search.contextual_retrieval', 'search.contextual_retrieval_disabled', 'search.cross_modal.both_mode_image_weight', 'search.cross_modal.both_mode_text_weight', 'search.cross_modal.llm_intent', 'search.evidence_cosine_floor', 'search.expansion', 'search.expansion_variant_budget', 'search.floor_ratio', 'search.graph_signals', 'search.image_query.image_refinement_weight', 'search.image_query.text_refinement_weight', 'search.intentWeighting', 'search.intent_patterns', 'search.keywordOrFallback', 'search.keyword_arm_confidence_floor', 'search.metadata_boost_gate', 'search.mode', 'search.relational_rerank_pin', 'search.relational_retrieval', 'search.relational_retrieval_depth', 'search.reranker.enabled', 'search.reranker.model', 'search.reranker.timeout_ms', 'search.reranker.top_n_in', 'search.reranker.top_n_out', 'search.searchLimit', 'search.title_boost', 'search.tokenBudget', 'search.unified_multimodal', 'search.unified_multimodal_only', 'search_embedding_column')
             AND (n.key IS NULL OR o.key IS NULL OR n.value IS DISTINCT FROM o.value) LIMIT 1;
        END IF;
        RETURN NULL;
      END;
      $srcmut$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS graph_search_config_insert ON config;
      CREATE TRIGGER graph_search_config_insert AFTER INSERT ON config REFERENCING NEW TABLE AS new_config
        FOR EACH STATEMENT EXECUTE FUNCTION note_graph_search_config_fn();
      DROP TRIGGER IF EXISTS graph_search_config_delete ON config;
      CREATE TRIGGER graph_search_config_delete AFTER DELETE ON config REFERENCING OLD TABLE AS old_config
        FOR EACH STATEMENT EXECUTE FUNCTION note_graph_search_config_fn();
      DROP TRIGGER IF EXISTS graph_search_config_update ON config;
      CREATE TRIGGER graph_search_config_update AFTER UPDATE ON config REFERENCING NEW TABLE AS new_config OLD TABLE AS old_config
        FOR EACH STATEMENT EXECUTE FUNCTION note_graph_search_config_fn();
      DROP TRIGGER IF EXISTS source_mutation_sources_insert ON sources;
      CREATE TRIGGER source_mutation_sources_insert AFTER INSERT ON sources REFERENCING NEW TABLE AS new_sources
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_sources_fn();
      DROP TRIGGER IF EXISTS source_mutation_sources_delete ON sources;
      CREATE TRIGGER source_mutation_sources_delete AFTER DELETE ON sources REFERENCING OLD TABLE AS old_sources
        FOR EACH STATEMENT EXECUTE FUNCTION note_source_mutation_sources_fn();
`;
