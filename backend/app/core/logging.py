import json
import logging
import re

SENSITIVE = re.compile(
    r"(?i)(bearer\s+\S+|sk-[\w-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|"
    r"(?:password|api[_-]?key|token)\s*[=:]\s*[^\s,;]+)"
)


class RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        # Do not serialize record.args, exception objects, request bodies, or headers.
        payload = {
            "level": record.levelname,
            "event": SENSITIVE.sub("[REDACTED]", record.getMessage()),
        }
        for key in ("request_id", "method", "route", "status", "duration_ms"):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging() -> None:
    logger = logging.getLogger("weibiye")
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(RedactingFormatter())
        logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
