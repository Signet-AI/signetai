use std::path::{Path, PathBuf};

fn canonical_root(root: &Path) -> std::io::Result<PathBuf> {
    root.canonicalize()
}

fn child(root: &Path, parts: &[&str]) -> std::io::Result<PathBuf> {
    let root = canonical_root(root)?;
    let path = parts
        .iter()
        .fold(root.clone(), |path, part| path.join(part));
    if !path.starts_with(&root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "workspace path escaped configured root",
        ));
    }
    Ok(path)
}

pub(crate) fn child_dir(root: &Path, parts: &[&str]) -> std::io::Result<PathBuf> {
    let dir = child(root, parts)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub(crate) fn child_file(root: &Path, parts: &[&str]) -> std::io::Result<PathBuf> {
    let Some((file, dirs)) = parts.split_last() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "workspace file path requires a file name",
        ));
    };
    Ok(child_dir(root, dirs)?.join(file))
}

pub(crate) fn config_file(root: &Path, file: &str) -> std::io::Result<PathBuf> {
    if file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid config file name",
        ));
    }
    let root = canonical_root(root)?;
    let path = root.join(file);
    if !path.starts_with(&root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "config file escaped configured workspace root",
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::{child_file, config_file};

    #[test]
    fn resolves_workspace_child_file_under_canonical_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path =
            child_file(dir.path(), &[".daemon", "logs", "transcripts", "audit.log"]).unwrap();

        assert!(path.starts_with(dir.path().canonicalize().unwrap()));
        assert!(path.parent().unwrap().exists());
    }

    #[test]
    fn rejects_config_file_traversal() {
        let dir = tempfile::tempdir().expect("tempdir");

        assert!(config_file(dir.path(), "../AGENTS.md").is_err());
        assert!(config_file(dir.path(), "nested/AGENTS.md").is_err());
        assert!(config_file(dir.path(), "AGENTS.md").is_ok());
    }
}
