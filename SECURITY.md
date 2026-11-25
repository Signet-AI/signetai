# Security Policy

We love responsible reports of (potential) security issues in SignetAI.

You can contact us at nicholai@signetai.sh.

Be sure to provide as much information as possible and if found also reproduction steps of the identified vulnerability. Also add the specific URL of the project as well as code you found the issue in to your report.

## Vulnerability Handling Process

- **Acknowledgement:** We aim to acknowledge receipt of your report within 3–5 business days.
- **Triage:** We will review the report, assess impact and severity, and determine the affected components and versions.
- **Remediation:** For valid reports, we will work on a fix and prepare a release or patch. Timelines depend on the complexity and impact of the issue.
- **Communication:** We will keep you reasonably informed of our progress and may request additional information if needed.

## Bundled Dependencies

The `signetai` npm package and the native binaries bundle their JavaScript dependencies, so the package declares none and `npm audit` cannot see them. Each release lists the bundled third-party packages in a CycloneDX SBOM: `sbom.cdx.json` inside the npm package, and `signetai-sbom.cdx.json` on the GitHub release. Point any CycloneDX-aware scanner at that file. The SBOM covers the npm package, the daemon runtime, the dashboard, and the linux-x64 native binary. Other native binaries share that JavaScript but carry their own platform builds of the keyring and sqlite-vec addons, which it does not list. The desktop app and the Docker image are not covered.

A release cannot publish while that SBOM contains a package with a high or critical advisory, and a weekly job re-audits the published `latest` and `next` SBOMs against new advisories.

## Disclosure & Advisories

We prefer **coordinated disclosure**. Once a fix is available, we will agree with you on a reasonable disclosure timeline that minimizes risk for users while recognizing your contribution.

When appropriate, we will:

- Publish a security advisory and/or release notes describing the vulnerability, affected versions, and mitigation steps.
- Credit you as the reporter, if you wish, while respecting any request for anonymity.

Please do not publicly disclose details of an unpatched vulnerability without prior coordination with us.
