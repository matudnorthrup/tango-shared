# Intake webhooks

Tango can treat a website-form submission relayed through a Discord webhook as
authorized user input. Each webhook is bound to exactly one Discord channel and
one Tango agent, and its configured label becomes the synthetic sender name in
session records.

Repo defaults live in `config/defaults/intake-webhooks.yaml`. Installations put
real values in `~/.tango/profiles/<profile>/config/intake-webhooks.yaml`; when
present, that profile file replaces the repo placeholder list.

```yaml
intake_webhooks:
  - webhook_id: "100000000000000101"
    channel_id: "100000000000000102"
    agent_id: papa
    label: form-intake
```

The trust boundary is the webhook URL's secrecy plus exact channel binding and
explicit configuration. Anyone holding the webhook URL can submit requests, so
the URL is a secret and must never be committed. The configured pair bypasses
ordinary user allowlists only in its bound channel. Unconfigured webhooks and a
configured webhook used in another channel are ignored. Tango also rejects any
intake webhook ID present in `~/.tango/slots/webhooks.json`, which contains its
own reply webhooks, and keeps the zero-width-space loop guard used by synced
messages.
