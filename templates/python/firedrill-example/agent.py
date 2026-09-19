"""A deterministic example client, not an LLM. Replace with your agent entry point."""

import json
import os
import sys
import urllib.error
import urllib.request


def main():
    invocation = json.load(sys.stdin)
    requested = invocation["input"]["value"]
    request = urllib.request.Request(
        os.environ["FIREDRILL_HTTP_URL"] + "/v1/operations/resource-store/records.set",
        data=json.dumps({
            "arguments": {"value": requested},
            "idempotencyKey": f"starter-{requested}",
        }).encode(),
        headers={
            "Authorization": "Bearer " + os.environ["FIREDRILL_HTTP_TOKEN"],
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        print(error.read().decode(), file=sys.stderr)
        return 1
    if result.get("outcome", {}).get("status") != "ok":
        print(json.dumps(result), file=sys.stderr)
        return 1
    print(json.dumps({"changed": result["outcome"]["value"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
