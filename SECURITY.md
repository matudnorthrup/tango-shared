# Security Policy

## Reporting

Do not open a public issue for credential exposure, personal-data leaks, or
other sensitive vulnerabilities.

Report the issue privately to the maintainers with:

- affected files or surfaces
- reproduction steps
- impact
- whether the issue is currently exploitable

## Repository Hygiene

Before contributing, check:

- `npm run cli -- doctor`
- tracked config changes under `config/defaults`
- tracked prompt changes under `agents/`
- runtime artifacts under `data/`

Do not commit:

- secrets
- tokens
- personal contact data
- live browser profiles
- private infrastructure identifiers unless they are deliberately sanitized
