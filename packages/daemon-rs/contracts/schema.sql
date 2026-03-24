CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE schema_migrations (
            version     INTEGER PRIMARY KEY,
            applied_at  TEXT NOT NULL,
            checksum    TEXT NOT NULL
        );
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  harness       TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  summary       TEXT,
  topics        TEXT,
  decisions     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  vector_clock  TEXT NOT NULL DEFAULT '{}',
  version       INTEGER DEFAULT 1,
  manual_override INTEGER DEFAULT 0
);
CREATE TABLE embeddings (
  id            TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  vector        BLOB NOT NULL,
  dimensions    INTEGER NOT NULL,
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  chunk_text    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_conversations_session ON conversations(session_id);
CREATE INDEX idx_conversations_harness ON conversations(harness);
CREATE INDEX idx_embeddings_source ON embeddings(source_type, source_id);
CREATE INDEX idx_embeddings_dims ON embeddings(dimensions);
CREATE TABLE conflict_log (
  id            TEXT PRIMARY KEY,
  table_name    TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  local_version TEXT NOT NULL,
  remote_version TEXT NOT NULL,
  resolution    TEXT NOT NULL,
  resolved_at   TEXT NOT NULL,
  resolved_by   TEXT NOT NULL
);
CREATE TABLE "memories" (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL DEFAULT 'fact',
  category        TEXT,
  content         TEXT NOT NULL,
  confidence      REAL DEFAULT 1.0,
  source_id       TEXT,
  source_type     TEXT DEFAULT 'manual',
  tags            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by      TEXT NOT NULL DEFAULT 'legacy',
  vector_clock    TEXT NOT NULL DEFAULT '{}',
  version         INTEGER DEFAULT 1,
  manual_override INTEGER DEFAULT 0,
  who             TEXT,
  why             TEXT,
  project         TEXT,
  session_id      TEXT,
  importance      REAL DEFAULT 0.5,
  last_accessed   TEXT,
  access_count    INTEGER DEFAULT 0,
  pinned          INTEGER DEFAULT 0
, content_hash TEXT, normalized_content TEXT, is_deleted INTEGER DEFAULT 0, deleted_at TEXT, extraction_status TEXT DEFAULT 'none', embedding_model TEXT, extraction_model TEXT, update_count INTEGER DEFAULT 0, idempotency_key TEXT, runtime_path TEXT, source_path TEXT, source_section TEXT, agent_id TEXT DEFAULT 'default', visibility TEXT DEFAULT 'global');
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_source ON memories(source_type, source_id);
CREATE INDEX idx_memories_created ON memories(created_at DESC);
CREATE INDEX idx_memories_agent_id ON memories(agent_id);
CREATE INDEX idx_memories_agent_visibility ON memories(agent_id, visibility);
-- migration 043: agent roster (multi-agent support)
CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  read_policy  TEXT NOT NULL DEFAULT 'isolated',
  policy_group TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE VIRTUAL TABLE memories_fts USING fts5(content, content=memories, content_rowid=rowid)
/* memories_fts(content) */;
CREATE TABLE 'memories_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE 'memories_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE 'memories_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE 'memories_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TABLE schema_migrations_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			version INTEGER NOT NULL,
			applied_at TEXT NOT NULL,
			duration_ms INTEGER,
			checksum TEXT
		);
CREATE INDEX idx_memories_pinned
			ON memories(pinned);
CREATE INDEX idx_memories_importance
			ON memories(importance DESC);
CREATE TABLE memory_history (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			event TEXT NOT NULL,
			old_content TEXT,
			new_content TEXT,
			changed_by TEXT NOT NULL,
			reason TEXT,
			metadata TEXT,
			created_at TEXT NOT NULL, actor_type TEXT, session_id TEXT, request_id TEXT,
			FOREIGN KEY (memory_id) REFERENCES memories(id)
		);
CREATE TABLE entities (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			entity_type TEXT NOT NULL,
			description TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		, canonical_name TEXT, mentions INTEGER DEFAULT 0, embedding BLOB, agent_id TEXT NOT NULL DEFAULT 'default', pinned INTEGER NOT NULL DEFAULT 0, pinned_at TEXT);
CREATE TABLE relations (
			id TEXT PRIMARY KEY,
			source_entity_id TEXT NOT NULL,
			target_entity_id TEXT NOT NULL,
			relation_type TEXT NOT NULL,
			strength REAL DEFAULT 1.0,
			metadata TEXT,
			created_at TEXT NOT NULL, mentions INTEGER DEFAULT 1, confidence REAL DEFAULT 0.5, updated_at TEXT,
			FOREIGN KEY (source_entity_id) REFERENCES entities(id),
			FOREIGN KEY (target_entity_id) REFERENCES entities(id)
		);
CREATE TABLE memory_entity_mentions (
			memory_id TEXT NOT NULL,
			entity_id TEXT NOT NULL, mention_text TEXT, confidence REAL, created_at TEXT,
			PRIMARY KEY (memory_id, entity_id),
			FOREIGN KEY (memory_id) REFERENCES memories(id),
			FOREIGN KEY (entity_id) REFERENCES entities(id)
		);
CREATE INDEX idx_memories_is_deleted
			ON memories(is_deleted);
CREATE INDEX idx_memories_extraction_status
			ON memories(extraction_status);
CREATE INDEX idx_memory_history_memory_id
			ON memory_history(memory_id);
CREATE INDEX idx_relations_source
			ON relations(source_entity_id);
CREATE INDEX idx_relations_target
			ON relations(target_entity_id);
CREATE INDEX idx_memory_entity_mentions_entity
			ON memory_entity_mentions(entity_id);
CREATE UNIQUE INDEX idx_memories_content_hash_unique
			ON memories(content_hash)
			WHERE content_hash IS NOT NULL AND is_deleted = 0
	;
CREATE INDEX idx_memories_deleted_at
			ON memories(deleted_at)
			WHERE is_deleted = 1;
CREATE INDEX idx_memory_history_created_at
			ON memory_history(created_at);
CREATE INDEX idx_entities_canonical_name ON entities(canonical_name);
CREATE INDEX idx_relations_composite ON relations(source_entity_id, relation_type);
CREATE UNIQUE INDEX idx_memories_idempotency_key
		 ON memories(idempotency_key)
		 WHERE idempotency_key IS NOT NULL;
CREATE TABLE documents (
			id TEXT PRIMARY KEY,
			source_url TEXT,
			source_type TEXT NOT NULL,
			content_type TEXT,
			content_hash TEXT,
			title TEXT,
			raw_content TEXT,
			status TEXT NOT NULL DEFAULT 'queued',
			error TEXT,
			connector_id TEXT,
			chunk_count INTEGER NOT NULL DEFAULT 0,
			memory_count INTEGER NOT NULL DEFAULT 0,
			metadata_json TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT
		);
CREATE INDEX idx_documents_status
		 ON documents(status);
CREATE INDEX idx_documents_source_url
		 ON documents(source_url);
CREATE INDEX idx_documents_connector_id
		 ON documents(connector_id);
CREATE INDEX idx_documents_content_hash
		 ON documents(content_hash);
CREATE TABLE document_memories (
			document_id TEXT NOT NULL REFERENCES documents(id),
			memory_id TEXT NOT NULL REFERENCES memories(id),
			chunk_index INTEGER,
			PRIMARY KEY (document_id, memory_id)
		);
CREATE TABLE connectors (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			display_name TEXT,
			config_json TEXT NOT NULL,
			cursor_json TEXT,
			status TEXT NOT NULL DEFAULT 'idle',
			last_sync_at TEXT,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
CREATE INDEX idx_connectors_provider
		 ON connectors(provider);
CREATE VIRTUAL TABLE vec_embeddings USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[768] distance_metric=cosine
);
CREATE TABLE "vec_embeddings_info" (key text primary key, value any);
CREATE TABLE "vec_embeddings_chunks"(chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,size INTEGER NOT NULL,validity BLOB NOT NULL,rowids BLOB NOT NULL);
CREATE TABLE "vec_embeddings_rowids"(rowid INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,chunk_id INTEGER,chunk_offset INTEGER);
CREATE TABLE "vec_embeddings_vector_chunks00"(rowid PRIMARY KEY,vectors BLOB NOT NULL);
CREATE UNIQUE INDEX idx_embeddings_content_hash_unique
			ON embeddings(content_hash)
	;
CREATE TABLE summary_jobs (
			id TEXT PRIMARY KEY,
			session_key TEXT,
			harness TEXT NOT NULL,
			project TEXT,
			transcript TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT,
			attempts INTEGER DEFAULT 0,
			max_attempts INTEGER DEFAULT 3,
			created_at TEXT NOT NULL,
			completed_at TEXT,
			error TEXT
		);
CREATE INDEX idx_summary_jobs_status
		 ON summary_jobs(status);
CREATE TABLE umap_cache (
			id INTEGER PRIMARY KEY,
			dimensions INTEGER NOT NULL,
			embedding_count INTEGER NOT NULL,
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
CREATE INDEX idx_embeddings_hash ON embeddings(content_hash);
CREATE TABLE session_scores (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			project TEXT,
			harness TEXT,
			score REAL NOT NULL,
			memories_recalled INTEGER,
			memories_used INTEGER,
			novel_context_count INTEGER,
			reasoning TEXT,
			created_at TEXT NOT NULL
		, confidence REAL, continuity_reasoning TEXT);
CREATE INDEX idx_session_scores_project
			ON session_scores(project, created_at);
CREATE INDEX idx_session_scores_session
			ON session_scores(session_key);
CREATE TABLE scheduled_tasks (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			prompt TEXT NOT NULL,
			cron_expression TEXT NOT NULL,
			harness TEXT NOT NULL,
			working_directory TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			last_run_at TEXT,
			next_run_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		, skill_name TEXT, skill_mode TEXT
			 CHECK (skill_mode IN ('inject', 'slash') OR skill_mode IS NULL));
CREATE INDEX idx_scheduled_tasks_enabled_next
			ON scheduled_tasks(enabled, next_run_at);
CREATE TABLE task_runs (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
			status TEXT NOT NULL DEFAULT 'pending',
			started_at TEXT NOT NULL,
			completed_at TEXT,
			exit_code INTEGER,
			stdout TEXT,
			stderr TEXT,
			error TEXT
		);
CREATE INDEX idx_task_runs_task_id
			ON task_runs(task_id);
CREATE INDEX idx_task_runs_status
			ON task_runs(status);
CREATE TABLE ingestion_jobs (
			id TEXT PRIMARY KEY,
			source_path TEXT NOT NULL,
			source_type TEXT NOT NULL,
			file_hash TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			chunks_total INTEGER DEFAULT 0,
			chunks_processed INTEGER DEFAULT 0,
			memories_created INTEGER DEFAULT 0,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			error TEXT
		);
CREATE INDEX idx_ingestion_jobs_status
			ON ingestion_jobs(status);
CREATE INDEX idx_ingestion_jobs_file_hash
			ON ingestion_jobs(file_hash);
CREATE INDEX idx_ingestion_jobs_source_path
			ON ingestion_jobs(source_path);
CREATE TABLE telemetry_events (
			id TEXT PRIMARY KEY,
			event TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			properties TEXT NOT NULL,
			sent_to_posthog INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		);
CREATE INDEX idx_telemetry_events_event
			ON telemetry_events(event);
CREATE INDEX idx_telemetry_events_timestamp
			ON telemetry_events(timestamp);
CREATE INDEX idx_telemetry_events_unsent
			ON telemetry_events(sent_to_posthog) WHERE sent_to_posthog = 0;
CREATE TABLE session_memories (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			source TEXT NOT NULL,
			effective_score REAL,
			predictor_score REAL,
			final_score REAL NOT NULL,
			rank INTEGER NOT NULL,
			was_injected INTEGER NOT NULL,
			relevance_score REAL,
			fts_hit_count INTEGER NOT NULL DEFAULT 0,
			agent_preference TEXT,
			created_at TEXT NOT NULL, entity_slot INTEGER, aspect_slot INTEGER, is_constraint INTEGER NOT NULL DEFAULT 0, structural_density INTEGER, predictor_rank INTEGER, agent_relevance_score REAL, agent_feedback_count INTEGER DEFAULT 0,
			UNIQUE(session_key, memory_id)
		);
CREATE INDEX idx_session_memories_session
			ON session_memories(session_key);
CREATE INDEX idx_session_memories_memory
			ON session_memories(memory_id);
CREATE TABLE session_checkpoints (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			harness TEXT NOT NULL,
			project TEXT,
			project_normalized TEXT,
			trigger TEXT NOT NULL,
			digest TEXT NOT NULL,
			prompt_count INTEGER NOT NULL,
			memory_queries TEXT,
			recent_remembers TEXT,
			created_at TEXT NOT NULL
		, focal_entity_ids TEXT, focal_entity_names TEXT, active_aspect_ids TEXT, surfaced_constraint_count INTEGER, traversal_memory_count INTEGER);
CREATE INDEX idx_checkpoints_session
			ON session_checkpoints(session_key, created_at DESC);
CREATE INDEX idx_checkpoints_project
			ON session_checkpoints(project_normalized, created_at DESC);
CREATE TABLE skill_meta (
			entity_id     TEXT PRIMARY KEY REFERENCES entities(id),
			agent_id      TEXT NOT NULL DEFAULT 'default',
			version       TEXT,
			author        TEXT,
			license       TEXT,
			source        TEXT NOT NULL,
			role          TEXT NOT NULL DEFAULT 'utility',
			triggers      TEXT,
			tags          TEXT,
			permissions   TEXT,
			enriched      INTEGER DEFAULT 0,
			installed_at  TEXT NOT NULL,
			last_used_at  TEXT,
			use_count     INTEGER DEFAULT 0,
			importance    REAL DEFAULT 0.7,
			decay_rate    REAL DEFAULT 0.99,
			fs_path       TEXT NOT NULL,
			uninstalled_at TEXT,
			created_at    TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
		);
CREATE INDEX idx_skill_meta_agent ON skill_meta(agent_id);
CREATE INDEX idx_skill_meta_source ON skill_meta(source);
CREATE INDEX idx_entities_agent ON entities(agent_id);
CREATE TABLE entity_aspects (
			id             TEXT PRIMARY KEY,
			entity_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			agent_id       TEXT NOT NULL DEFAULT 'default',
			name           TEXT NOT NULL,
			canonical_name TEXT NOT NULL,
			weight         REAL NOT NULL DEFAULT 0.5,
			created_at     TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(entity_id, canonical_name)
		);
CREATE INDEX idx_entity_aspects_entity ON entity_aspects(entity_id);
CREATE INDEX idx_entity_aspects_agent ON entity_aspects(agent_id);
CREATE INDEX idx_entity_aspects_weight ON entity_aspects(weight DESC);
CREATE TABLE entity_attributes (
			id                 TEXT PRIMARY KEY,
			aspect_id          TEXT REFERENCES entity_aspects(id) ON DELETE SET NULL,
			agent_id           TEXT NOT NULL DEFAULT 'default',
			memory_id          TEXT REFERENCES memories(id) ON DELETE SET NULL,
			kind               TEXT NOT NULL,
			content            TEXT NOT NULL,
			normalized_content TEXT NOT NULL,
			confidence         REAL NOT NULL DEFAULT 0.0,
			importance         REAL NOT NULL DEFAULT 0.5,
			status             TEXT NOT NULL DEFAULT 'active',
			superseded_by      TEXT,
			created_at         TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
		);
CREATE INDEX idx_entity_attributes_aspect ON entity_attributes(aspect_id);
CREATE INDEX idx_entity_attributes_agent ON entity_attributes(agent_id);
CREATE INDEX idx_entity_attributes_kind ON entity_attributes(kind);
CREATE INDEX idx_entity_attributes_status ON entity_attributes(status);
CREATE TABLE entity_dependencies (
			id                TEXT PRIMARY KEY,
			source_entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			target_entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			agent_id          TEXT NOT NULL DEFAULT 'default',
			aspect_id         TEXT REFERENCES entity_aspects(id) ON DELETE SET NULL,
			dependency_type   TEXT NOT NULL,
			strength          REAL NOT NULL DEFAULT 0.5,
			created_at        TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
		);
CREATE INDEX idx_entity_dependencies_source ON entity_dependencies(source_entity_id);
CREATE INDEX idx_entity_dependencies_target ON entity_dependencies(target_entity_id);
CREATE INDEX idx_entity_dependencies_agent ON entity_dependencies(agent_id);
CREATE TABLE task_meta (
			entity_id        TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
			agent_id         TEXT NOT NULL DEFAULT 'default',
			status           TEXT NOT NULL,
			expires_at       TEXT,
			retention_until  TEXT,
			completed_at     TEXT,
			updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
		);
CREATE INDEX idx_task_meta_agent ON task_meta(agent_id);
CREATE INDEX idx_task_meta_status ON task_meta(status);
CREATE INDEX idx_task_meta_retention ON task_meta(retention_until);
CREATE TABLE predictor_comparisons (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			predictor_ndcg REAL NOT NULL,
			baseline_ndcg REAL NOT NULL,
			predictor_won INTEGER NOT NULL,
			margin REAL NOT NULL,
			alpha REAL NOT NULL,
			ema_updated INTEGER NOT NULL DEFAULT 0,
			focal_entity_id TEXT,
			focal_entity_name TEXT,
			project TEXT,
			candidate_count INTEGER NOT NULL,
			traversal_count INTEGER NOT NULL DEFAULT 0,
			constraint_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		, scorer_confidence REAL NOT NULL DEFAULT 0, success_rate REAL NOT NULL DEFAULT 0.5, predictor_top_ids TEXT NOT NULL DEFAULT '[]', baseline_top_ids TEXT NOT NULL DEFAULT '[]', relevance_scores TEXT NOT NULL DEFAULT '{}', fts_overlap_score REAL);
CREATE INDEX idx_predictor_comparisons_session
			ON predictor_comparisons(session_key);
CREATE INDEX idx_predictor_comparisons_agent
			ON predictor_comparisons(agent_id);
CREATE INDEX idx_predictor_comparisons_project
			ON predictor_comparisons(project);
CREATE INDEX idx_predictor_comparisons_entity
			ON predictor_comparisons(focal_entity_id);
CREATE TABLE predictor_training_log (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL DEFAULT 'default',
			model_version INTEGER NOT NULL,
			loss REAL NOT NULL,
			sample_count INTEGER NOT NULL,
			duration_ms INTEGER NOT NULL,
			canary_ndcg REAL,
			canary_ndcg_delta REAL,
			canary_score_variance REAL,
			canary_topk_churn REAL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
CREATE INDEX idx_predictor_training_agent
			ON predictor_training_log(agent_id);
CREATE INDEX idx_entities_pinned ON entities(agent_id, pinned, pinned_at DESC);
CREATE TABLE predictor_training_pairs (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL DEFAULT 'default',
			session_key TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			-- Feature vector (anonymized -- no content, just structural features)
			recency_days REAL NOT NULL,
			access_count INTEGER NOT NULL,
			importance REAL NOT NULL,
			decay_factor REAL NOT NULL,
			embedding_similarity REAL,
			entity_slot INTEGER,
			aspect_slot INTEGER,
			is_constraint INTEGER NOT NULL DEFAULT 0,
			structural_density INTEGER,
			fts_hit_count INTEGER NOT NULL DEFAULT 0,
			-- Label (ground truth)
			agent_relevance_score REAL,
			continuity_score REAL,
			fts_overlap_score REAL,
			combined_label REAL NOT NULL,
			-- Metadata
			was_injected INTEGER NOT NULL,
			predictor_rank INTEGER,
			baseline_rank INTEGER,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
CREATE INDEX idx_training_pairs_agent
			ON predictor_training_pairs(agent_id);
CREATE INDEX idx_training_pairs_session
			ON predictor_training_pairs(session_key);
CREATE TABLE memories_cold (
			archive_id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			type TEXT DEFAULT 'fact',
			category TEXT,
			content TEXT NOT NULL,
			confidence REAL DEFAULT 1.0,
			importance REAL DEFAULT 0.5,
			source_id TEXT,
			source_type TEXT,
			tags TEXT,
			who TEXT,
			why TEXT,
			project TEXT,
			content_hash TEXT,
			normalized_content TEXT,
			extraction_status TEXT,
			embedding_model TEXT,
			extraction_model TEXT,
			update_count INTEGER DEFAULT 0,
			original_created_at TEXT NOT NULL,
			archived_at TEXT NOT NULL,
			archived_reason TEXT,
			cold_source_id TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			original_row_json TEXT
		);
CREATE INDEX idx_cold_memory_id ON memories_cold(memory_id);
CREATE INDEX idx_cold_agent ON memories_cold(agent_id);
CREATE INDEX idx_cold_project ON memories_cold(project);
CREATE INDEX idx_cold_archived_at ON memories_cold(archived_at);
CREATE INDEX idx_cold_source ON memories_cold(cold_source_id);
CREATE TABLE session_summaries (
			id TEXT PRIMARY KEY,
			project TEXT,
			depth INTEGER NOT NULL DEFAULT 0,
			kind TEXT NOT NULL CHECK(kind IN ('session', 'arc', 'epoch')),
			content TEXT NOT NULL,
			token_count INTEGER,
			earliest_at TEXT NOT NULL,
			latest_at TEXT NOT NULL,
			session_key TEXT,
			harness TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL
		);
CREATE TABLE session_summary_children (
			parent_id TEXT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
			child_id TEXT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
			ordinal INTEGER NOT NULL,
			PRIMARY KEY (parent_id, child_id)
		);
CREATE TABLE session_summary_memories (
			summary_id TEXT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
			memory_id TEXT NOT NULL,
			PRIMARY KEY (summary_id, memory_id)
		);
CREATE INDEX idx_summaries_project_depth ON session_summaries(project, depth);
CREATE INDEX idx_summaries_kind ON session_summaries(kind);
CREATE INDEX idx_summaries_agent ON session_summaries(agent_id);
CREATE INDEX idx_summaries_latest ON session_summaries(latest_at DESC);
CREATE INDEX idx_summary_children_child ON session_summary_children(child_id);
CREATE INDEX idx_summaries_session_key ON session_summaries(session_key);
CREATE UNIQUE INDEX idx_summaries_session_depth
			ON session_summaries(session_key, depth)
			WHERE session_key IS NOT NULL;
CREATE TABLE "memory_jobs" (
			id TEXT PRIMARY KEY,
			memory_id TEXT,
			job_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			payload TEXT,
			result TEXT,
			attempts INTEGER DEFAULT 0,
			max_attempts INTEGER DEFAULT 3,
			leased_at TEXT,
			completed_at TEXT,
			failed_at TEXT,
			error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			document_id TEXT,
			FOREIGN KEY (memory_id) REFERENCES memories(id)
		);
CREATE INDEX idx_memory_jobs_status
			ON memory_jobs(status);
CREATE INDEX idx_memory_jobs_memory_id
			ON memory_jobs(memory_id);
CREATE INDEX idx_memory_jobs_completed_at
			ON memory_jobs(completed_at);
CREATE INDEX idx_memory_jobs_failed_at
			ON memory_jobs(failed_at);
