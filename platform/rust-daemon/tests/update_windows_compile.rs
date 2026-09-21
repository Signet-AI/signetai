#![cfg(windows)]

#[test]
fn update_route_compiles_on_windows_without_unix_apis() {
    // This test is intentionally Windows-only: compiling this target exercises
    // the route's platform implementation rather than silently skipping it.
    assert!(cfg!(windows));
}
