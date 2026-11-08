"""Offline by default; real QQ requires a later authorization and three explicit flags."""

import argparse
import importlib.util
import json


class PrivateParser(argparse.ArgumentParser):
    def error(self, message):
        if not message.startswith(("Serve requires", "Choose a free", "Official WebSocket")):
            message = "Invalid options; provide credentials only through process environment"
        super().error(message)


def main(argv=None):
    parser = PrivateParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group()
    choice.add_argument("--prepare-local", action="store_true")
    choice.add_argument("--serve", action="store_true")
    parser.add_argument("--target")
    parser.add_argument("--port", type=int, default=38712)
    parser.add_argument("--confirm-qq-network", action="store_true")
    parser.add_argument("--confirm-qq-send", action="store_true")
    parser.add_argument("--confirm-c2c-approved", action="store_true")
    args = parser.parse_args(argv)
    if not args.serve and not args.prepare_local:
        present = importlib.util.find_spec("websockets") is not None
        print(
            json.dumps(
                {
                    "status": "P872_OFFLINE_READY" if present else "P872_QQ_EXTRA_REQUIRED",
                    "credentials_read": False,
                    "real_qq_connections": 0,
                    "real_qq_messages": 0,
                    "real_model_requests": 0,
                    "default_mode": "mock",
                    "websocket_dependency": present,
                }
            )
        )
        return 0 if present else 1
    from scripts.p871_qq_sandbox import sanitize_child_environment

    if args.prepare_local:
        sanitize_child_environment()
        from app.modules.qq_p871.sandbox import prepare_local

        print(
            json.dumps(
                {
                    "status": "P872_ISOLATED_TARGET_PREPARED",
                    "target": str(prepare_local()),
                    "real_qq_connections": 0,
                    "real_model_requests": 0,
                }
            )
        )
        return 0
    if not (
        args.target
        and args.confirm_qq_network
        and args.confirm_qq_send
        and args.confirm_c2c_approved
    ):
        parser.error("Serve requires an isolated --target and all three QQ/C2C confirmation flags")
    if not 1024 <= args.port <= 65535 or args.port in {25433, 26380, 60130, 60131, 38711}:
        parser.error("Choose a free isolated loopback port")
    from app.modules.qq_p871.sandbox import load_local

    load_local(args.target)
    from app.modules.qq_p871.config import load_options

    options = load_options(authorize_secret_read=True)
    if options.mode != "official-websocket" or not options.allow_network or not options.allow_send:
        parser.error("Official WebSocket mode and network/send environment gates are required")
    sanitize_child_environment()
    from app.modules.qq_p872.app import create_websocket_app

    app = create_websocket_app(
        args.target, options, approved_c2c=True, authorize_network=True, local_port=args.port
    )
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False, log_level="warning")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        raise SystemExit(
            "P872 stopped: isolation/configuration failed; credentials hidden"
        ) from None
