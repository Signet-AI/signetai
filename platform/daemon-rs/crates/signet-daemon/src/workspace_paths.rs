use std::path::{Path, PathBuf};

fn canonical_root(root: &Path) -> std::io::Result<PathBuf> {
    root.canonicalize()
}

fn validate_part(part: &str) -> std::io::Result<()> {
    if part.is_empty()
        || part == "."
        || part == ".."
        || part.contains('/')
        || part.contains('\\')
        || Path::new(part).is_absolute()
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "workspace path contains an unsafe component",
        ));
    }
    Ok(())
}

fn child(root: &Path, parts: &[&str]) -> std::io::Result<PathBuf> {
    let root = canonical_root(root)?;
    for part in parts {
        validate_part(part)?;
    }
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

pub(crate) fn child_path(root: &Path, parts: &[&str]) -> std::io::Result<PathBuf> {
    child(root, parts)
}

pub(crate) fn child_dir(root: &Path, parts: &[&str]) -> std::io::Result<PathBuf> {
    let dir = child(root, parts)?;
    // lgtm[rust/path-injection] The root is the configured Signet workspace; child() canonicalizes it and rejects unsafe child components before filesystem access.
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub(crate) fn child_file(root: &Path, parts: &[&str]) -> std::io::Result<PathBuf> {
    let Some((_file, dirs)) = parts.split_last() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "workspace file path requires a file name",
        ));
    };
    let path = child(root, parts)?;
    if !dirs.is_empty() {
        let parent = child(root, dirs)?;
        // lgtm[rust/path-injection] The parent is derived by child(), which canonicalizes the workspace root and rejects unsafe child components before filesystem access.
        std::fs::create_dir_all(parent)?;
    }
    Ok(path)
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
    fn rejects_workspace_child_traversal() {
        let dir = tempfile::tempdir().expect("tempdir");

        assert!(child_file(dir.path(), &["skills", "..", "AGENTS.md"]).is_err());
        assert!(child_file(dir.path(), &["skills/escape", "SKILL.md"]).is_err());
        assert!(child_file(dir.path(), &["skills", "nested\\escape", "SKILL.md"]).is_err());
        assert!(child_file(dir.path(), &["skills", "safe", "SKILL.md"]).is_ok());
    }

    #[test]
    fn rejects_config_file_traversal() {
        let dir = tempfile::tempdir().expect("tempdir");

        assert!(config_file(dir.path(), "../AGENTS.md").is_err());
        assert!(config_file(dir.path(), "nested/AGENTS.md").is_err());
        assert!(config_file(dir.path(), "AGENTS.md").is_ok());
    }
}
