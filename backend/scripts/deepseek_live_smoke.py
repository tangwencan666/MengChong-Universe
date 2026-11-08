"""One explicitly approved synthetic request; never a backend startup helper.

No confirmation or no process-local key means no SDK construction or network.
This CLI never reads chat, memory, a database, a .env file, or another process.
"""

import argparse
import asyncio
import json
import logging
import os
import re
from contextlib import aclosing
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import TextIO
from uuid import uuid4

from pydantic import SecretStr

from app.agent.providers import DeepSeekProvider
from app.core.config import Settings
from app.core.errors import AppError

REPORT_ROOT = Path(__file__).resolve().parents[2] / ".verification" / "p8"
MODEL = "deepseek-flash"
SYSTEM_PROMPT = "Follow the user instruction."
USER_PROMPT = "Reply exactly OK."
SAFE_ERROR_CODES = frozenset(
    {
        "REAL_LLM_DISABLED",
        "PROVIDER_AUTH_FAILED",
        "PROVIDER_BILLING_UNAVAILABLE",
        "PROVIDER_RATE_LIMITED",
        "PROVIDER_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_FAILED",
    }
)


class PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # A mistyped --key argument must not echo its value to a terminal/log.
        self.exit(2, "Invalid options. Use --help; keys are read from the environment only.\n")


def empty_result(status: str) -> dict:
    return {
        "status": status,
        "configured_model": MODEL,
        "provider_invocations": 0,
        "paid_request_may_have_occurred": False,
        "usage": None,
        "usage_details": None,
        "actual_cost_usd": None,
        "estimated_cost_usd_at_reference_peak_prices": None,
        "cost_note": "Actual charges require the provider's billing record.",
    }


def capture_usage(result: dict, provider: DeepSeekProvider) -> None:
    """Whitelist metadata; SDK response bodies, prompts and errors stay private."""
    usage = provider.usage
    if (
        isinstance(usage, dict)
        and set(usage) == {"input_tokens", "output_tokens"}
        and all(type(value) is int and value >= 0 for value in usage.values())
    ):
        result["usage"] = dict(usage)
        details = provider.usage_details
        if isinstance(details, dict):
            result["usage_details"] = {
                key: details[key]
                for key in (
                    "total_tokens",
                    "prompt_cache_hit_tokens",
                    "prompt_cache_miss_tokens",
                )
                if key in details and type(details[key]) is int and details[key] >= 0
            }
        # Conservative reference estimate if the provider omits cache counters.
        hit = (result["usage_details"] or {}).get("prompt_cache_hit_tokens", 0)
        if hit > usage["input_tokens"]:
            hit = 0
        miss = usage["input_tokens"] - hit
        estimate = (
            Decimal(hit) * Decimal("0.006")
            + Decimal(miss) * Decimal("0.30")
            + Decimal(usage["output_tokens"]) * Decimal("1.20")
        ) / Decimal(1_000_000)
        result["estimated_cost_usd_at_reference_peak_prices"] = format(estimate, "f")
        result["reference_price_date"] = "2026-11-02"
        result["reference_price_source"] = "https://api-docs.deepseek.com/quick_start/pricing/"
    response_model = provider.response_model
    if isinstance(response_model, str) and re.fullmatch(
        r"deepseek[-A-Za-z0-9_.:]{0,100}", response_model
    ):
        result["response_model"] = response_model


async def run_once(key: SecretStr) -> dict:
    result = empty_result("LIVE_TEST_FAILED")
    provider = None
    # Deliberately ignore unrelated WEIBIYE_* environment settings. There is no
    # dependency on database URLs, a saved provider mode, or memory feature flags.
    settings = Settings(
        _env_prefix="WEIBIYE_P8_SMOKE_UNUSED_",
        _env_file=None,
        llm_provider="deepseek",
        real_llm_enabled=True,
        deepseek_api_key=key,
        deepseek_model=MODEL,
        deepseek_max_tokens=32,
        deepseek_timeout_seconds=15,
        memory_management_enabled=False,
        memory_injection_enabled=False,
    )
    previous_log_threshold = logging.root.manager.disable
    # Even an inherited SDK debug setting must not print request details.
    logging.disable(logging.CRITICAL)
    try:
        provider = DeepSeekProvider(settings)
        result["provider_invocations"] = 1
        result["paid_request_may_have_occurred"] = True
        reply = ""
        async with asyncio.timeout(18):
            async with aclosing(
                provider.stream([{"role": "user", "content": USER_PROMPT}], SYSTEM_PROMPT)
            ) as chunks:
                async for chunk in chunks:
                    # A smoke result is a boolean, never an echoed model body.
                    if not isinstance(chunk, str) or len(reply) + len(chunk) > 256:
                        raise AppError(503, "PROVIDER_FAILED", "Invalid smoke response")
                    reply += chunk
        capture_usage(result, provider)
        result["expected_reply_received"] = reply.strip() == "OK"
        result["finish_reason"] = (
            provider.finish_reason if provider.finish_reason in {"stop", "length"} else None
        )
        result["status"] = (
            "LIVE_TEST_COMPLETED"
            if result["expected_reply_received"] and result["finish_reason"] == "stop"
            else "LIVE_TEST_RESPONSE_MISMATCH"
        )
    except asyncio.CancelledError:
        result["status"] = "LIVE_TEST_CANCELLED"
    except TimeoutError:
        result["error_code"] = "PROVIDER_TIMEOUT"
    except AppError as error:
        result["error_code"] = error.code if error.code in SAFE_ERROR_CODES else "PROVIDER_FAILED"
    except Exception:
        result["error_code"] = "PROVIDER_FAILED"
    finally:
        logging.disable(previous_log_threshold)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = PrivateArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm-paid-request",
        action="store_true",
        help="Only use after the user separately approves this one paid synthetic request.",
    )
    parser.add_argument(
        "--report", action="store_true", help="Save new sanitized JSON under .verification/p8."
    )
    args = parser.parse_args(argv)
    report: TextIO | None = None
    report_path = None
    if not args.confirm_paid_request:
        result = empty_result("LIVE_TEST_NOT_CONFIRMED")
    else:
        raw_key = os.environ.get("WEIBIYE_DEEPSEEK_API_KEY", "")
        if not raw_key.strip():
            result = empty_result("LIVE_TEST_KEY_NOT_VISIBLE")
        else:
            try:
                if args.report:
                    REPORT_ROOT.mkdir(parents=True, exist_ok=True)
                    report_path = REPORT_ROOT / f"deepseek-live-{uuid4().hex}.json"
                    # Reserve a new report before a paid request; never overwrite.
                    report = report_path.open("x", encoding="utf-8")
                result = asyncio.run(run_once(SecretStr(raw_key)))
            except KeyboardInterrupt:
                result = empty_result("LIVE_TEST_CANCELLED")
                result["paid_request_may_have_occurred"] = True
            except Exception:
                # No exception text/traceback: configuration and SDK errors can
                # contain credentials. A failed report preflight never retries.
                result = empty_result("LIVE_TEST_PREFLIGHT_FAILED")
            finally:
                raw_key = ""
    result["completed_at"] = datetime.now(UTC).isoformat()
    if report is not None:
        try:
            report.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
            report.flush()
            result["report_path"] = str(report_path)
        except OSError:
            result["report_save_failed"] = True
        finally:
            report.close()
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "LIVE_TEST_COMPLETED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
