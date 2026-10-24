# discord_send_image

Send an image to a Discord channel or thread, presented under your own agent
persona. Use it to show the user what you see: a queued-up cart or booking
screenshot before submitting, a product photo, a map, or any other visual aid.

## Input

```json
{
  "source": "/tmp/tango-screenshot-1718046000123.png",
  "channel_id": "100000000000000003",
  "agent_id": "sierra",
  "caption": "Here is your Chipotle cart — 2x chicken bowls, total $24.10. Reply 'confirm' and I'll place the order."
}
```

## Fields

- `source` — absolute local image path **or** https image URL.
  - Local paths must live under the allowed upload directories
    (`/tmp/tango-*` such as browser screenshots, or the Tango data dir).
  - URLs must be https and resolve to an actual image content type.
- `channel_id` — destination channel or thread ID. The current conversation's
  ids appear in the "Current user message metadata" block each turn: use
  `discord_thread_id` when present, otherwise `discord_channel_id`.
- `agent_id` — your own agent id (lowercase, e.g. `sierra`). The image is
  delivered through the Tango Replies webhook with your display name/avatar.
- `caption` — optional message text (≤1900 chars) sent with the image.

## Confirm-before-purchase protocol

Before any irreversible submit, order, booking, or payment:

1. Drive the flow to the final review state (cart, checkout summary, booking
   confirmation page) **without submitting**.
2. Take a screenshot with the `browser` tool (`action: "screenshot"`).
3. Send it with `discord_send_image`. The caption must summarize the key
   details — items, total price, delivery address, dates — and explicitly ask
   the user to confirm.
4. **End your turn and wait.** Do not submit until the user replies
   affirmatively. If the user asks for changes, make them and repeat from
   step 1.

## Common flow: browser screenshot

```json
{ "action": "screenshot" }                    // browser tool → { "screenshot_path": "/tmp/tango-screenshot-....png" }
{ "source": "<screenshot_path>", ... }        // discord_send_image
```

## Notes

- Supported formats: png, jpg, jpeg, gif, webp. Max 8MB
  (override with `TANGO_DISCORD_UPLOAD_MAX_BYTES`).
- Delivery prefers the per-channel "Tango Replies" webhook (agent persona);
  if webhook delivery is unavailable the image is sent by the bot account and
  the result includes a `note` saying so.
- The result includes `message_id`, `delivery` (`webhook` | `bot`),
  `filename`, and `size_bytes`. An `error` field means nothing was sent.
- Images send immediately, mid-turn — the user sees the image before your
  final text reply. Use that for confirmation flows.
