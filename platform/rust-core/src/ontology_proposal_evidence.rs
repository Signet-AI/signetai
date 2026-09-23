use crate::{
    memory_content_safety::{is_memory_content_context_eligible, MemoryContentSafetySourceKind},
    required_agent, CoreError, OntologyProposalEvidenceRequest, Value,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

#[derive(Clone)]
struct Ref {
    source_kind: Option<String>,
    source_id: Option<String>,
    source_path: Option<String>,
    memory_id: Option<String>,
    quote: Option<String>,
    reference: Value,
}

fn table_exists(db: &Connection, name: &str) -> Result<bool, CoreError> {
    Ok(db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            [name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}
fn column_exists(db: &Connection, table: &str, column: &str) -> Result<bool, CoreError> {
    let mut stmt = db.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names.iter().any(|name| name == column))
}
fn string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
fn parse_ref(value: &Value) -> Option<Ref> {
    if let Some(text) = value.as_str() {
        return (!text.trim().is_empty()).then(|| Ref {
            source_kind: None,
            source_id: Some(text.trim().into()),
            source_path: None,
            memory_id: None,
            quote: None,
            reference: value.clone(),
        });
    }
    let object = value.as_object()?;
    let proposal = string(value, "proposal_id");
    let transcript = string(value, "transcript_id");
    let session = string(value, "session_key");
    Some(Ref {
        source_kind: string(value, "source_kind")
            .or_else(|| proposal.as_ref().map(|_| "ontology_proposal".into()))
            .or_else(|| (transcript.is_some() || session.is_some()).then(|| "transcript".into())),
        source_id: string(value, "source_id")
            .or(proposal)
            .or(transcript)
            .or(session)
            .or_else(|| string(value, "session_id"))
            .or_else(|| string(value, "source")),
        source_path: string(value, "source_path"),
        memory_id: string(value, "memory_id"),
        quote: string(value, "quote"),
        reference: Value::Object(object.clone()),
    })
}
fn compact(content: &str, quote: Option<&str>) -> String {
    let text = content.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 1200;
    if text.chars().count() <= MAX {
        return text;
    }
    let chars = text.chars().collect::<Vec<_>>();
    if let Some(q) = quote {
        let q = q.split_whitespace().collect::<Vec<_>>().join(" ");
        let lower = text.to_lowercase();
        if let Some(idx) = lower.find(&q.to_lowercase()) {
            let start = idx.saturating_sub(MAX.saturating_sub(q.chars().count()) / 2);
            let start = text[..start.min(text.len())]
                .char_indices()
                .last()
                .map(|(i, _)| i)
                .unwrap_or(0);
            let start_char = text[..start].chars().count();
            let end_char = (start_char + MAX).min(chars.len());
            return format!(
                "{}{}{}",
                if start_char > 0 { "..." } else { "" },
                chars[start_char..end_char]
                    .iter()
                    .collect::<String>()
                    .trim(),
                if end_char < chars.len() { "..." } else { "" }
            );
        }
    }
    format!("{}...", chars[..MAX - 3].iter().collect::<String>().trim())
}
fn key(r: &Ref) -> String {
    [
        r.source_kind.as_deref().unwrap_or(""),
        r.source_id.as_deref().unwrap_or(""),
        r.source_path.as_deref().unwrap_or(""),
        r.memory_id.as_deref().unwrap_or(""),
        r.quote.as_deref().unwrap_or(""),
    ]
    .join("\0")
}
fn ids(value: Option<&str>) -> Vec<String> {
    let Some(v) = value else { return vec![] };
    let mut out = Vec::new();
    for x in [
        Some(v.to_owned()),
        Some(v.strip_prefix("transcript:").unwrap_or(v).to_owned()),
        Some(v.strip_prefix("session:").unwrap_or(v).to_owned()),
        (!v.starts_with("transcript:") && !v.starts_with("session:"))
            .then(|| format!("transcript:{v}")),
        (!v.starts_with("session:")).then(|| format!("session:{v}")),
    ]
    .into_iter()
    .flatten()
    {
        if !x.trim().is_empty() && !out.contains(&x) {
            out.push(x)
        }
    }
    out
}
fn artifact(
    db: &Connection,
    agent: &str,
    r: &Ref,
) -> Result<Option<(String, String, String, Option<String>, String)>, CoreError> {
    if !table_exists(db, "memory_artifacts")? {
        return Ok(None);
    }
    let candidates = ids(r.source_id.as_deref());
    let mut filters = vec!["agent_id=?".to_owned(), "COALESCE(is_deleted,0)=0".into()];
    let mut args: Vec<String> = vec![agent.into()];
    if let Some(path) = &r.source_path {
        filters.push("source_path=?".into());
        args.push(path.clone())
    } else if !candidates.is_empty() {
        let ph = vec!["?"; candidates.len()].join(",");
        filters.push(format!("(source_node_id IN ({ph}) OR session_id IN ({ph}) OR session_key IN ({ph}) OR session_token IN ({ph}) OR source_path IN ({ph}))"));
        for _ in 0..5 {
            args.extend(candidates.clone())
        }
    } else {
        return Ok(None);
    }
    let sql=format!("SELECT source_path,source_kind,session_id,session_key,content FROM memory_artifacts WHERE {} ORDER BY captured_at DESC LIMIT 1",filters.join(" AND "));
    let row = db
        .query_row(&sql, rusqlite::params_from_iter(args.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .optional()?;
    if let Some((p, _k, _s, _key, c)) = &row {
        if !is_memory_content_context_eligible(
            db,
            agent,
            MemoryContentSafetySourceKind::Artifact,
            p,
            c,
        )? {
            return Ok(None);
        }
    }
    Ok(row)
}
fn resolve(db: &Connection, agent: &str, r: &Ref) -> Result<Value, CoreError> {
    if r.source_kind.as_deref() == Some("ontology_proposal")
        && table_exists(db, "ontology_proposals")?
    {
        if let Some((id,op,why,evidence))=db.query_row("SELECT id,operation,rationale,evidence FROM ontology_proposals WHERE id=? AND agent_id=? LIMIT 1",params![r.source_id,agent],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?))).optional()? {
            let content=format!("{op}\n{why}\n{evidence}"); if is_memory_content_context_eligible(db,agent,MemoryContentSafetySourceKind::Artifact,&id,&content)? {return Ok(json!({"kind":"ontology_proposal","found":true,"sourceKind":"ontology_proposal","sourceId":id,"sourcePath":r.source_path,"label":format!("proposal:{id}"),"excerpt":compact(if r.quote.as_deref().unwrap_or("").is_empty(){if !why.is_empty(){&why}else{&evidence}}else{r.quote.as_deref().unwrap()},None),"reference":r.reference}))}
        }
    }
    if r.source_path.is_some() {
        if let Some((path, kind, session, key, content)) = artifact(db, agent, r)? {
            return Ok(
                json!({"kind":"memory_artifact","found":true,"sourceKind":kind,"sourceId":key.or(Some(session)),"sourcePath":path,"label":path,"excerpt":compact(&content,r.quote.as_deref()),"reference":r.reference}),
            );
        }
    }
    let is_transcript = r
        .source_kind
        .as_deref()
        .is_some_and(|s| s == "transcript" || s == "session_transcript")
        || r.source_id
            .as_deref()
            .is_some_and(|s| s.starts_with("transcript:") || s.starts_with("session:"));
    if is_transcript && table_exists(db, "session_transcripts")? {
        let c = column_exists(db, "session_transcripts", "updated_at")?;
        let order = if c {
            "COALESCE(updated_at,created_at)"
        } else {
            "created_at"
        };
        let candidates = ids(r.source_id.as_deref());
        if !candidates.is_empty() {
            let ph = vec!["?"; candidates.len()].join(",");
            let sql=format!("SELECT session_key,content FROM session_transcripts WHERE agent_id=? AND session_key IN ({ph}) ORDER BY {order} DESC LIMIT 1");
            let mut args = vec![agent.to_owned()];
            args.extend(candidates);
            if let Some((id, content)) = db
                .query_row(&sql, rusqlite::params_from_iter(args.iter()), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .optional()?
            {
                if is_memory_content_context_eligible(
                    db,
                    agent,
                    MemoryContentSafetySourceKind::Transcript,
                    &id,
                    &content,
                )? {
                    return Ok(
                        json!({"kind":"session_transcript","found":true,"sourceKind":r.source_kind.clone().unwrap_or("transcript".into()),"sourceId":id,"sourcePath":r.source_path,"label":format!("transcript:{id}"),"excerpt":compact(&content,r.quote.as_deref()),"reference":r.reference}),
                    );
                }
            }
        }
    }
    if r.source_path.is_none() {
        if let Some((path, kind, session, key, content)) = artifact(db, agent, r)? {
            return Ok(
                json!({"kind":"memory_artifact","found":true,"sourceKind":kind,"sourceId":key.or(Some(session)),"sourcePath":path,"label":path,"excerpt":compact(&content,r.quote.as_deref()),"reference":r.reference}),
            );
        }
    }
    if let Some(id) = &r.memory_id {
        if table_exists(db, "memories")? {
            if let Some((mid,source_id,source_type,path,content))=db.query_row("SELECT id,source_id,source_type,source_path,content FROM memories WHERE id=? AND agent_id=? AND COALESCE(is_deleted,0)=0 LIMIT 1",params![id,agent],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,String>(4)?))).optional()?{if is_memory_content_context_eligible(db,agent,MemoryContentSafetySourceKind::Memory,&mid,&content)?{return Ok(json!({"kind":"memory","found":true,"sourceKind":source_type,"sourceId":source_id.unwrap_or_else(||mid.clone()),"sourcePath":path,"label":format!("memory:{mid}"),"excerpt":compact(&content,r.quote.as_deref()),"reference":r.reference}))}}
        }
    }
    if let Some(q) = &r.quote {
        return Ok(
            json!({"kind":"provided_quote","found":true,"sourceKind":r.source_kind,"sourceId":r.source_id,"sourcePath":r.source_path,"label":"embedded quote","excerpt":compact(q,None),"reference":r.reference}),
        );
    }
    Ok(
        json!({"kind":"unresolved","found":false,"sourceKind":r.source_kind,"sourceId":r.source_id,"sourcePath":r.source_path,"label":r.source_path.as_deref().or(r.source_id.as_deref()).or(r.memory_id.as_deref()).unwrap_or("unknown evidence"),"excerpt":"","reference":r.reference}),
    )
}
fn parse_json(value: &str, fallback: Value) -> Value {
    serde_json::from_str(value).unwrap_or(fallback)
}
pub fn execute(
    db: &Connection,
    request: OntologyProposalEvidenceRequest,
) -> Result<Value, CoreError> {
    let agent = required_agent(&request.agent_id)?;
    let row=db.query_row("SELECT id,agent_id,operation,status,payload,confidence,rationale,evidence,risk,source_kind,source_id,source_path,source_root,created_by,applied_by,rejected_by,result,created_at,updated_at,applied_at,rejected_at FROM ontology_proposals WHERE id=? AND agent_id=?",params![request.id,agent],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,f64>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,Option<String>>(8)?,row.get::<_,Option<String>>(9)?,row.get::<_,Option<String>>(10)?,row.get::<_,Option<String>>(11)?,row.get::<_,Option<String>>(12)?,row.get::<_,String>(13)?,row.get::<_,Option<String>>(14)?,row.get::<_,Option<String>>(15)?,row.get::<_,Option<String>>(16)?,row.get::<_,String>(17)?,row.get::<_,String>(18)?,row.get::<_,Option<String>>(19)?,row.get::<_,Option<String>>(20)?))).optional()?.ok_or_else(||CoreError::NotFoundMessage("Proposal not found".into()))?;
    let (
        id,
        agent_id,
        operation,
        status,
        payload,
        confidence,
        rationale,
        evidence,
        risk,
        source_kind,
        source_id,
        source_path,
        source_root,
        created_by,
        applied_by,
        rejected_by,
        result,
        created_at,
        updated_at,
        applied_at,
        rejected_at,
    ) = row;
    let proposal = json!({"id":id,"agentId":agent_id,"operation":operation,"status":status,"payload":parse_json(&payload,json!({})),"confidence":confidence,"rationale":rationale,"evidence":parse_json(&evidence,json!([])),"risk":risk,"sourceKind":source_kind,"sourceId":source_id,"sourcePath":source_path,"sourceRoot":source_root,"createdBy":created_by,"appliedBy":applied_by,"rejectedBy":rejected_by,"result":result.as_deref().map(|s|parse_json(s,json!({}))).filter(|v|v.as_object().is_some_and(|o|!o.is_empty())),"createdAt":created_at,"updatedAt":updated_at,"appliedAt":applied_at,"rejectedAt":rejected_at});
    let mut refs = Vec::new();
    if let Some(array) = proposal["evidence"].as_array() {
        for value in array {
            if let Some(r) = parse_ref(value) {
                refs.push(r)
            }
        }
    }
    if source_id.is_some() || source_path.is_some() || source_kind.is_some() {
        let reference = json!({"source_kind":source_kind,"source_id":source_id,"source_path":source_path,"source_root":source_root});
        refs.push(Ref {
            source_kind: source_kind.clone(),
            source_id: source_id.clone(),
            source_path: source_path.clone(),
            memory_id: None,
            quote: None,
            reference,
        });
    }
    let mut seen = std::collections::HashSet::new();
    refs.retain(|r| seen.insert(key(r)));
    let mut items = Vec::new();
    for r in &refs {
        items.push(resolve(db, &agent, r)?)
    }
    Ok(json!({"proposal":proposal,"count":items.len(),"items":items}))
}
