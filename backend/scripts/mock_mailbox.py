"""Inspect local Mock mail, never another project or a production mailbox."""

import argparse
import json
from pathlib import Path

from app.core.config import Settings
from app.modules.auth.mock_mailbox import read_mailbox


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["list", "show"])
    parser.add_argument("message_id", nargs="?")
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--reveal", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    if settings.environment == "production":
        raise SystemExit("File Mock mail is unavailable in production")
    directory = (
        args.directory
        or settings.mock_mail_dir
        or Path(__file__).resolve().parents[2] / ".verification/mock-mail"
    )
    messages = read_mailbox(directory)
    if args.command == "list":
        print(
            json.dumps(
                [
                    {key: value[key] for key in ("id", "recipient", "purpose", "created_at")}
                    for value in messages
                ],
                ensure_ascii=True,
            )
        )
        return
    if not args.reveal or not args.message_id:
        raise SystemExit("Use show MESSAGE_ID --reveal explicitly for a private local Mock link")
    message = next((value for value in messages if value["id"] == args.message_id), None)
    if message is None:
        raise SystemExit("Mock message not found")
    print(json.dumps(message, ensure_ascii=True))


if __name__ == "__main__":
    main()
