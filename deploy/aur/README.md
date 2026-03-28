# Arch package metadata

Generate AUR metadata from a tagged AppImage release:

```bash
bash deploy/aur/generate-pkgbuild.sh <version> <appimage_url> <sha256>
```

This writes:

- `deploy/aur/PKGBUILD`
- `deploy/aur/.SRCINFO`

Both files are ignored in git and emitted by CI as artifacts.
Publish by copying these files into the `signet-desktop-bin` AUR repo.
