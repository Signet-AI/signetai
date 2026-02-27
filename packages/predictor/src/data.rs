use std::path::Path;

use rusqlite::Connection;

#[derive(Debug, Clone)]
pub struct TrainingSample {
    pub session_id: String,
    pub query_embedding: Vec<f64>,
    pub candidate_embeddings: Vec<Vec<f64>>,
    pub candidate_features: Vec<Vec<f64>>,
    pub project_slot: usize,
    pub labels: Vec<f64>,
}

#[derive(Debug)]
pub enum DataError {
    Sql(rusqlite::Error),
}

impl From<rusqlite::Error> for DataError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sql(value)
    }
}

pub fn load_training_samples(
    db_path: &Path,
    limit: usize,
) -> Result<Vec<TrainingSample>, DataError> {
    let connection = Connection::open(db_path)?;

    let mut stmt = connection
        .prepare("SELECT session_key FROM session_scores ORDER BY created_at DESC LIMIT ?1")?;

    let mut rows = stmt.query([limit as i64])?;
    let mut samples = Vec::new();
    while let Some(row) = rows.next()? {
        let session_key: String = row.get(0)?;
        samples.push(TrainingSample {
            session_id: session_key,
            query_embedding: Vec::new(),
            candidate_embeddings: Vec::new(),
            candidate_features: Vec::new(),
            project_slot: 0,
            labels: Vec::new(),
        });
    }

    Ok(samples)
}
