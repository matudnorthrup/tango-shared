#!/usr/bin/env python3
"""Batch FatSecret API executor.

Usage:
  fatsecret-batch.py '[{"method":"food_entry_create","params":{...}}, ...]'

Returns:
  {"results": [{"ok": true, "result": ...}, {"ok": false, "error": "..."}]}
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

from fatsecret import Fatsecret

DATE_PARAMS = {"date", "from_date", "to_date"}


def resolve_path(env_key: str, default: Path) -> Path:
    configured = os.environ.get(env_key)
    if configured and configured.strip():
        return Path(configured.strip()).expanduser()
    return default


def get_client():
    secrets_path = resolve_path(
        "TANGO_FATSECRET_SECRETS_PATH",
        Path.home() / "legacy-agent" / "secrets" / "fatsecret-api.json",
    )
    tokens_path = resolve_path(
        "TANGO_FATSECRET_TOKENS_PATH",
        Path.home() / "legacy-agent" / "secrets" / "fatsecret-user-tokens.json",
    )
    with open(secrets_path) as f:
        creds = json.load(f)
    with open(tokens_path) as f:
        tokens = json.load(f)
    return Fatsecret(
        creds["oauth1"]["consumer_key"],
        creds["oauth1"]["consumer_secret"],
        session_token=tokens["session_token"],
    )


def convert_dates(params):
    converted = dict(params)
    for key in DATE_PARAMS:
      if key in converted and isinstance(converted[key], str):
          converted[key] = datetime.strptime(converted[key], "%Y-%m-%d").replace(hour=12)
    return converted


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: fatsecret-batch.py <json_calls>"}))
        sys.exit(1)

    try:
        calls = json.loads(sys.argv[1])
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"Invalid JSON calls: {exc}"}))
        sys.exit(1)

    if not isinstance(calls, list):
        print(json.dumps({"error": "Calls payload must be a JSON array."}))
        sys.exit(1)

    fs = get_client()
    results = []

    for call in calls:
        if not isinstance(call, dict):
            results.append({"ok": False, "error": "Batch item must be an object."})
            continue

        method_name = call.get("method")
        params = call.get("params", {})

        if not isinstance(method_name, str) or not method_name.strip():
            results.append({"ok": False, "error": "Batch item is missing a method."})
            continue
        if not isinstance(params, dict):
            results.append({"ok": False, "error": f"{method_name} params must be an object."})
            continue
        if not hasattr(fs, method_name):
            results.append({"ok": False, "error": f"Unknown method: {method_name}"})
            continue

        try:
            result = getattr(fs, method_name)(**convert_dates(params))
            results.append({"ok": True, "result": result})
        except Exception as exc:
            results.append({"ok": False, "error": str(exc)})

    print(json.dumps({"results": results}, default=str))


if __name__ == "__main__":
    main()
