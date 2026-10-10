# Security policy

Siverse runs AI agents on your computer, so security reports matter to us.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and click **Report a vulnerability**.

Please include:

- what an attacker can do, and what they need (for example a web page you visit, a local process, or a prompt-injected file or web page);
- steps to reproduce;
- your OS, Node version, engine (API or Claude Code) and mode.

We'll acknowledge your report as soon as we can and keep you updated until it's fixed.

## Scope

The [Safety notes](README.md#safety-notes) in the README describe the known limits, for example that Claude Code engine workers can currently read files outside the company drive and that the server must never be bound to a non-local address. A report that one of those limits is weaker than described is in scope. So are ways around the localhost guard, the write sandbox, approved-command checks or the secret filtering.
