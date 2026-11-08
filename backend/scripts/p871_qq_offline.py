"""Offline readiness check only. Never load process credentials or start a server."""

import argparse
import importlib.util
import json


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    crypto = importlib.util.find_spec("cryptography") is not None
    result = {
        "status": "P871_OFFLINE_DEPENDENCIES_READY" if crypto else "P871_QQ_EXTRA_REQUIRED",
        "default_mode": "mock",
        "credentials_read": False,
        "real_qq_connections": 0,
        "real_qq_messages": 0,
        "real_model_requests": 0,
        "httpx_available": importlib.util.find_spec("httpx") is not None,
        "ed25519_available": crypto,
        "real_sandbox_server_started": False,
        "next_step": "Authorize an isolated app composition and HTTPS callback before live testing",
    }
    print(json.dumps(result))
    return 0 if crypto and result["httpx_available"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
