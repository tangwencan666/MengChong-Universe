"""Prepare isolated storage or explicitly serve an authorized Mock-model QQ sandbox."""

import argparse
import json
import os


def sanitize_child_environment():
    # Names only, then deletion: never inspect inherited model credential values.
    for name in tuple(os.environ):
        if name.upper().startswith(("WEIBIYE_", "DEEPSEEK_", "OPENAI_", "QQ_", "TENCENT_")):
            del os.environ[name]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--prepare-local", action="store_true")
    choice.add_argument("--serve", action="store_true")
    parser.add_argument("--target")
    parser.add_argument("--port", type=int, default=38711)
    parser.add_argument("--confirm-qq-network", action="store_true")
    parser.add_argument("--confirm-qq-send", action="store_true")
    parser.add_argument("--enable-callback-validation", action="store_true")
    args = parser.parse_args(argv)
    if args.prepare_local:
        sanitize_child_environment()
        from app.modules.qq_p871.sandbox import prepare_local

        print(
            json.dumps(
                {
                    "status": "P871_ISOLATED_TARGET_PREPARED",
                    "target": str(prepare_local()),
                    "qq_connections": 0,
                    "model_requests": 0,
                }
            )
        )
        return 0
    if not args.target or not args.confirm_qq_network or not args.confirm_qq_send:
        parser.error("Serve requires an isolated --target and both QQ confirmation flags")
    if not 1024 <= args.port <= 65535 or args.port in {25433, 26380, 60130, 60131}:
        parser.error("Choose a free non-shared loopback port")
    from app.modules.qq_p871.sandbox import load_local

    load_local(args.target)  # fail before ever looking up AppSecret
    from app.modules.qq_p871.config import load_options

    options = load_options(authorize_secret_read=True)
    if options.mode != "official-webhook" or not options.allow_network or not options.allow_send:
        parser.error("Official mode requires both process network/send gates")
    sanitize_child_environment()
    from app.modules.qq_p871.sandbox import create_local_app

    app = create_local_app(
        args.target,
        options,
        authorize_network=True,
        validation=args.enable_callback_validation,
        local_port=args.port,
    )
    import uvicorn

    # Loopback only; never create a tunnel, proxy, deployment or public listener.
    # Access logs are off to avoid raw callback paths/query strings.
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False, log_level="warning")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        raise SystemExit(
            "P871 startup stopped: isolation/configuration check failed; credentials hidden"
        ) from None
