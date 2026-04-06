# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release (stable channel) | Yes |
| main branch | Best-effort |

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues.**

Instead, please use one of:

1. **GitHub Private Advisory**: Go to the [Security tab](https://github.com/Lbstrydom/claude-engineering-skills/security/advisories/new) and create a private advisory
2. **Email**: Contact the maintainer directly

### What to include

- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Suggested fix (if you have one)

### Response SLA

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 1 week
- **Fix for critical issues**: within 2 weeks
- **Fix for non-critical issues**: within 1 month

## Security Practices

### Secret Handling
- `.env` files are gitignored and never committed
- API keys are never logged or sent to stderr
- Sensitive file patterns (`.env`, `.pem`, `.key`, `secret`, `credential`, `token`) are excluded from external API calls

### Supply Chain
- Stable releases include signed checksums (Sigstore cosign)
- GitHub Actions workflows use SHA-pinned actions
- Dependabot monitors npm and Actions dependencies weekly

### Code Execution
- All subprocess calls use `execFileSync` (no shell string interpolation)
- No `postinstall` scripts that execute fetched code
- Installer verifies checksums before writing files (stable channel)

## Verification

To verify a stable release:

```bash
# Download release assets
gh release download v1.0.0 -p 'checksums.json*'

# Verify with cosign (if installed)
cosign verify-blob \
  --certificate checksums.json.pem \
  --signature checksums.json.sig \
  --certificate-identity-regexp="^https://github\\.com/Lbstrydom/claude-engineering-skills/" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  checksums.json
```
