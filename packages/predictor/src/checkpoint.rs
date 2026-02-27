use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};

use crate::{autograd::Tape, model::CrossAttentionScorer};

const MAGIC: &[u8; 4] = b"SGPT";
const VERSION: u32 = 1;

#[derive(Debug)]
pub enum CheckpointError {
    Io(std::io::Error),
    InvalidFormat(String),
    Json(serde_json::Error),
}

impl From<std::io::Error> for CheckpointError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for CheckpointError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

#[derive(Debug)]
pub struct LoadedCheckpoint {
    pub version: u32,
    pub flags: u32,
    pub config: crate::model::ScorerConfig,
    pub params: Vec<Vec<f64>>,
}

pub fn save(
    path: &Path,
    model: &CrossAttentionScorer,
    tape: &Tape,
    flags: u32,
) -> Result<(), CheckpointError> {
    let mut file = File::create(path)?;
    let config_json = serde_json::to_vec(&model.config())?;

    file.write_all(MAGIC)?;
    file.write_all(&VERSION.to_le_bytes())?;
    file.write_all(&flags.to_le_bytes())?;
    file.write_all(&(config_json.len() as u32).to_le_bytes())?;
    file.write_all(&config_json)?;

    let param_indices = model.param_indices();
    file.write_all(&(param_indices.len() as u32).to_le_bytes())?;
    for param_idx in param_indices {
        let param = &tape.params()[param_idx];
        file.write_all(&(param.data.len() as u32).to_le_bytes())?;
        for value in &param.data {
            file.write_all(&value.to_le_bytes())?;
        }
    }

    Ok(())
}

pub fn load(path: &Path) -> Result<LoadedCheckpoint, CheckpointError> {
    let mut file = File::open(path)?;
    let mut magic = [0_u8; 4];
    file.read_exact(&mut magic)?;
    if &magic != MAGIC {
        return Err(CheckpointError::InvalidFormat("bad magic".to_string()));
    }

    let version = read_u32(&mut file)?;
    let flags = read_u32(&mut file)?;
    let config_len = read_u32(&mut file)? as usize;

    let mut config_bytes = vec![0_u8; config_len];
    file.read_exact(&mut config_bytes)?;
    let config: crate::model::ScorerConfig = serde_json::from_slice(&config_bytes)?;

    let param_count = read_u32(&mut file)? as usize;
    let mut params = Vec::with_capacity(param_count);
    for _ in 0..param_count {
        let len = read_u32(&mut file)? as usize;
        let mut values = Vec::with_capacity(len);
        for _ in 0..len {
            values.push(read_f64(&mut file)?);
        }
        params.push(values);
    }

    Ok(LoadedCheckpoint {
        version,
        flags,
        config,
        params,
    })
}

pub fn apply_checkpoint(
    loaded: &LoadedCheckpoint,
    model: &CrossAttentionScorer,
    tape: &mut Tape,
) -> Result<(), CheckpointError> {
    let param_indices = model.param_indices();
    if loaded.params.len() != param_indices.len() {
        return Err(CheckpointError::InvalidFormat(
            "parameter count mismatch".to_string(),
        ));
    }

    for (slot, param_idx) in param_indices.iter().enumerate() {
        let target = &mut tape.params_mut()[*param_idx];
        if target.data.len() != loaded.params[slot].len() {
            return Err(CheckpointError::InvalidFormat(format!(
                "parameter {} size mismatch: {} != {}",
                slot,
                target.data.len(),
                loaded.params[slot].len()
            )));
        }
        target.data.copy_from_slice(&loaded.params[slot]);
    }

    Ok(())
}

fn read_u32(reader: &mut dyn Read) -> Result<u32, CheckpointError> {
    let mut bytes = [0_u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_f64(reader: &mut dyn Read) -> Result<f64, CheckpointError> {
    let mut bytes = [0_u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(f64::from_le_bytes(bytes))
}
