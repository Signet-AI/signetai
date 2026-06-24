//! Permission matrix and scope enforcement.

use super::types::{AuthMode, Permission, PolicyDecision, TokenClaims, TokenRole, TokenScope};

// ---------------------------------------------------------------------------
// Permission matrix
// ---------------------------------------------------------------------------

fn role_has_permission(role: TokenRole, perm: Permission) -> bool {
    match role {
        TokenRole::Admin => true,
        TokenRole::Operator => !matches!(perm, Permission::Admin),
        TokenRole::Agent => matches!(
            perm,
            Permission::Remember
                | Permission::Recall
                | Permission::Modify
                | Permission::Forget
                | Permission::Recover
                | Permission::Documents
        ),
        TokenRole::Readonly => matches!(perm, Permission::Recall),
    }
}

fn role_name(role: TokenRole) -> &'static str {
    match role {
        TokenRole::Admin => "admin",
        TokenRole::Operator => "operator",
        TokenRole::Agent => "agent",
        TokenRole::Readonly => "readonly",
    }
}

fn permission_name(permission: Permission) -> &'static str {
    match permission {
        Permission::Remember => "remember",
        Permission::Recall => "recall",
        Permission::Modify => "modify",
        Permission::Forget => "forget",
        Permission::Recover => "recover",
        Permission::Admin => "admin",
        Permission::Documents => "documents",
        Permission::Connectors => "connectors",
        Permission::Diagnostics => "diagnostics",
        Permission::Analytics => "analytics",
    }
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

pub fn check_permission(
    claims: Option<&TokenClaims>,
    perm: Permission,
    mode: AuthMode,
) -> PolicyDecision {
    if mode == AuthMode::Local {
        return PolicyDecision {
            allowed: true,
            reason: None,
        };
    }

    let Some(claims) = claims else {
        return PolicyDecision {
            allowed: false,
            reason: Some("authentication required".into()),
        };
    };

    if !role_has_permission(claims.role, perm) {
        return PolicyDecision {
            allowed: false,
            reason: Some(format!(
                "role '{}' lacks '{}' permission",
                role_name(claims.role),
                permission_name(perm)
            )),
        };
    }

    if let Some(permissions) = claims.permissions.as_ref()
        && !permissions.contains(&perm)
    {
        return PolicyDecision {
            allowed: false,
            reason: Some(format!(
                "credential lacks '{}' permission",
                permission_name(perm)
            )),
        };
    }

    PolicyDecision {
        allowed: true,
        reason: None,
    }
}

// ---------------------------------------------------------------------------
// Scope check
// ---------------------------------------------------------------------------

pub fn check_scope(
    claims: Option<&TokenClaims>,
    target: &TokenScope,
    mode: AuthMode,
) -> PolicyDecision {
    if mode == AuthMode::Local {
        return PolicyDecision {
            allowed: true,
            reason: None,
        };
    }

    let Some(claims) = claims else {
        return PolicyDecision {
            allowed: false,
            reason: Some("authentication required".into()),
        };
    };

    // Admin bypasses scope
    if claims.role == TokenRole::Admin {
        return PolicyDecision {
            allowed: true,
            reason: None,
        };
    }

    // Unscoped tokens have full access
    if claims.scope.is_empty() {
        return PolicyDecision {
            allowed: true,
            reason: None,
        };
    }

    if let (Some(sp), Some(tp)) = (&claims.scope.project, &target.project)
        && sp != tp
    {
        return PolicyDecision {
            allowed: false,
            reason: Some(format!("scope restricted to project '{sp}'")),
        };
    }

    if let (Some(sa), Some(ta)) = (&claims.scope.agent, &target.agent)
        && sa != ta
    {
        return PolicyDecision {
            allowed: false,
            reason: Some(format!("scope restricted to agent '{sa}'")),
        };
    }

    if let (Some(su), Some(tu)) = (&claims.scope.user, &target.user)
        && su != tu
    {
        return PolicyDecision {
            allowed: false,
            reason: Some(format!("scope restricted to user '{su}'")),
        };
    }

    PolicyDecision {
        allowed: true,
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(role: TokenRole) -> TokenClaims {
        TokenClaims {
            sub: "test".into(),
            scope: TokenScope::default(),
            role,
            iat: 0,
            exp: i64::MAX,
            permissions: None,
        }
    }

    #[test]
    fn local_mode_allows_all() {
        let d = check_permission(None, Permission::Admin, AuthMode::Local);
        assert!(d.allowed);
    }

    #[test]
    fn admin_has_all_permissions() {
        let c = claims(TokenRole::Admin);
        for perm in [
            Permission::Remember,
            Permission::Recall,
            Permission::Admin,
            Permission::Diagnostics,
        ] {
            let d = check_permission(Some(&c), perm, AuthMode::Team);
            assert!(d.allowed, "{perm:?} should be allowed for admin");
        }
    }

    #[test]
    fn readonly_only_recall() {
        let c = claims(TokenRole::Readonly);
        assert!(check_permission(Some(&c), Permission::Recall, AuthMode::Team).allowed);
        assert!(!check_permission(Some(&c), Permission::Remember, AuthMode::Team).allowed);
        assert!(!check_permission(Some(&c), Permission::Admin, AuthMode::Team).allowed);
    }

    #[test]
    fn agent_no_admin() {
        let c = claims(TokenRole::Agent);
        assert!(check_permission(Some(&c), Permission::Remember, AuthMode::Team).allowed);
        assert!(!check_permission(Some(&c), Permission::Admin, AuthMode::Team).allowed);
        assert!(!check_permission(Some(&c), Permission::Diagnostics, AuthMode::Team).allowed);
    }

    #[test]
    fn scope_enforcement() {
        let mut c = claims(TokenRole::Agent);
        c.scope.project = Some("proj-a".into());

        let target = TokenScope {
            project: Some("proj-b".into()),
            ..Default::default()
        };
        assert!(!check_scope(Some(&c), &target, AuthMode::Team).allowed);

        let target = TokenScope {
            project: Some("proj-a".into()),
            ..Default::default()
        };
        assert!(check_scope(Some(&c), &target, AuthMode::Team).allowed);
    }

    #[test]
    fn admin_bypasses_scope() {
        let mut c = claims(TokenRole::Admin);
        c.scope.project = Some("proj-a".into());

        let target = TokenScope {
            project: Some("proj-b".into()),
            ..Default::default()
        };
        assert!(check_scope(Some(&c), &target, AuthMode::Team).allowed);
    }
}
